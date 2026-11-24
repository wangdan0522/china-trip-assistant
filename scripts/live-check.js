'use strict';

/**
 * 隔离式真实联网自检：不注入 fetch，不读取生产缓存，不写生产 data。
 *   node scripts/live-check.js
 * 退出码：所有必要类别完整且新鲜可用为 0；任一失败、过期或覆盖不完整为 1。
 * 新建页面哈希仅是本次检查的基线，不代表任何规则已完成人工核验。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-live-check-'));
Object.assign(process.env, {
  INBOUND_DATA_DIR: dir,
  LIVE_STATE_FILE: path.join(dir, 'live-state.json'),
  INBOUND_DB_FILE: path.join(dir, 'inbound.sqlite'),
  INBOUND_FEEDBACK_FILE: path.join(dir, 'feedback.jsonl'),
  INBOUND_HISTORY_FILE: path.join(dir, 'history.jsonl'),
  INBOUND_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
  INBOUND_REGISTRY_FILE: path.join(dir, 'unused-registry.json')
});

function cleanup() {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('清理本次临时目录失败：' + err.message);
    process.exitCode = 1;
  }
}
process.once('exit', cleanup);
process.once('SIGINT', () => { process.exitCode = 130; process.exit(); });
process.once('SIGTERM', () => { process.exitCode = 143; process.exit(); });

const live = require('../server/live');
const sources = require('../data/sources.json');
const places = require('../data/places.json').places;
const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'KRW', 'RUB', 'AUD', 'CAD', 'SGD', 'HKD', 'THB', 'MYR'];

function stamp(value) {
  const date = value == null ? null : new Date(value);
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : '无';
}

function reportState(label, result, reason) {
  console.log(`  ${label}：ok=${result.ok === true} · stale=${result.stale === true} · 抓取时间=${stamp(result.fetchedAt)} · 错误=${result.error || '无'}`);
  const fresh = result.ok === true && result.stale === false && !result.error && result.fetchedAt != null && stamp(result.fetchedAt) !== '无';
  console.log(`    缓存标识：${fresh ? '本次强制请求取得的新鲜结果' : result.fetchedAt != null ? '可能含缓存或不完整结果，不计本次完整成功' : '无可用缓存'}${reason ? ' · ' + reason : ''}`);
  return fresh;
}

async function main() {
  console.log('\n实时源联网自检 · ' + new Date().toISOString());
  console.log('隔离目录：' + dir);
  console.log('不读取生产状态或历史基线；所有请求走真实网络，结束仅清理本次创建的临时目录。\n');

  const checks = [
    ['天气', () => live.getWeather({ force: true })],
    ['汇率', () => live.getFx({ force: true })],
    ['页面变化监测', () => live.getPolicyWatch({ force: true })]
  ];
  const results = await Promise.allSettled(checks.map(([, load]) => Promise.resolve().then(load)));
  let usable = 0;
  for (const [index, settled] of results.entries()) {
    const label = checks[index][0];
    if (settled.status === 'rejected') {
      console.error(`  ${label}：失败 · ${settled.reason && settled.reason.message || String(settled.reason)}`);
      continue;
    }
    const result = settled.value;
    let complete = false;
    let fresh;
    if (index === 0) {
      const items = Array.isArray(result.items) ? result.items : [];
      const available = new Set(items.filter((item) => Number.isFinite(item.temp) && typeof item.cat === 'string' && Number.isFinite(Date.parse(item.at))).map((item) => item.id));
      const missing = places.filter((place) => !available.has(place.id)).map((place) => place.id);
      const provider = result.providerId || result.provider || result.source;
      const role = provider === sources.weather.primary.id || provider === sources.weather.primary.provider
        ? '主源' : provider === sources.weather.fallback.id || provider === sources.weather.fallback.provider ? '备源（主源未满足使用条件）' : '未确认';
      console.log(`  天气实际数据源：${result.ok ? result.source || provider || '未知' : '无成功数据源'} · ${role} · ${result.sourceUrl || '无来源地址'}`);
      console.log(`    配置顺序：${sources.weather.primary.provider} → ${sources.weather.fallback.provider}；未被调用的备源不视为已验证。`);
      console.log(`    地点覆盖：${available.size}/${places.length}${missing.length ? ' · 缺失或无效：' + missing.join(', ') : ''}`);
      fresh = reportState(label, result);
      complete = missing.length === 0 && places.length > 0;
    } else if (index === 1) {
      const rates = result.rates || {};
      const missing = currencies.filter((currency) => !Number.isFinite(rates[currency]) || rates[currency] <= 0);
      console.log(`  汇率实际数据源：${result.source || '未知'} · 配置地址=${sources.fx.url} · 无配置备源`);
      console.log(`    参考汇率发布时间：${result.updatedAt || '无'} · USD=${rates.USD ?? '不可用'} · EUR=${rates.EUR ?? '不可用'}`);
      console.log(`    币种覆盖：${currencies.length - missing.length}/${currencies.length}${missing.length ? ' · 缺失：' + missing.join(', ') : ''}`);
      fresh = reportState(label, result);
      const published = Date.parse(result.updatedAt);
      const age = Date.now() - published;
      complete = missing.length === 0 && Number.isFinite(published) && age >= -3600000 && age <= 48 * 3600000;
    } else {
      const rows = Array.isArray(result.sources) ? result.sources : [];
      for (const row of rows) {
        console.log(`  页面源：${row.id} · ${row.name} · ${row.url}`);
        console.log(`    状态=${row.status} · 相关标题=${row.titleCount} · 检查时间=${stamp(row.checkedAt)} · 错误=${row.error || '无'}`);
        if (row.status === 'baseline') console.log('    仅建立本次独立基线：没有历史对比，不表示规则已核验或内容未变化。');
        else if (row.status === 'unchanged') console.log('    仅说明本次内存基线范围内标题哈希未变化，不表示规则有效性已核验。');
      }
      fresh = reportState(label, result, result.persistenceError ? '状态持久化失败：' + result.persistenceError : '仅检查网页可达性与标题提取，不核验规则内容');
      complete = sources.policy.length > 0 && sources.policy.every((source) => rows.some((row) => row.id === source.id &&
        ['baseline', 'unchanged', 'changed'].includes(row.status) && row.titleCount > 0 && !row.error && row.checkedAt != null)) && !result.persistenceError;
      if (result.needsReview) console.log('    检测到变化，需要人工复核；本检查不会确认或改写规则。');
    }
    const passed = fresh && complete;
    console.log(`    类别结论：${passed ? '本次网络及完整性检查通过' : '失败或不完整，不计成功'}\n`);
    if (passed) usable += 1;
  }
  console.log(`${usable}/3 个必要类别完整且新鲜可用。${usable === 3 ? '网络检查通过；不代表规则已完成人工核验。' : '检查未全部通过；不得将部分成功视为全部成功。'}`);
  process.exitCode = usable === 3 ? 0 : 1;
}

main().catch((err) => {
  console.error('联网自检异常：' + (err.stack || err.message));
  process.exitCode = 1;
});
