'use strict';

const test = require('node:test');
const os = require('node:os');
const nodePath = require('node:path');
const fs = require('node:fs');
const testDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'inbound-live-'));
process.env.INBOUND_DATA_DIR = testDir;
delete process.env.LIVE_STATE_FILE;
test.after(() => fs.rmSync(testDir, { recursive: true, force: true }));
const CLOCK = Date.parse('2026-11-13T07:15:00Z');

const assert = require('node:assert/strict');

const live = require('../server/live');

/* ---------------- 打桩 ---------------- */

function jsonResponse(obj, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(obj), text: () => Promise.resolve(JSON.stringify(obj)) });
}
function htmlResponse(html, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, text: () => Promise.resolve(html), json: () => Promise.resolve({}) });
}

const WEATHER = [
  { current: { temperature_2m: 12.4, weather_code: 0, relative_humidity_2m: 40, wind_speed_10m: 3, time: '2026-11-13T15:15' } },
  { current: { temperature_2m: 18.9, weather_code: 3, relative_humidity_2m: 60, wind_speed_10m: 5, time: '2026-11-13T15:15' } },
  { current: { temperature_2m: 21.2, weather_code: 61, relative_humidity_2m: 80, wind_speed_10m: 2, time: '2026-11-13T15:15' } },
  { current: { temperature_2m: 17.1, weather_code: 45, relative_humidity_2m: 70, wind_speed_10m: 4, time: '2026-11-13T15:15' } },
  { current: { temperature_2m: 15.6, weather_code: 95, relative_humidity_2m: 75, wind_speed_10m: 1, time: '2026-11-13T15:15' } },
  { current: { temperature_2m: 16.3, weather_code: 2, relative_humidity_2m: 65, wind_speed_10m: 6, time: '2026-11-13T15:15' } }
];

const FX = {
  result: 'success',
  base_code: 'CNY',
  time_last_update_utc: 'Fri, 13 Nov 2026 00:02:31 +0000',
  rates: { CNY: 1, USD: 0.1385, EUR: 0.128, GBP: 0.11, JPY: 21.4, KRW: 190.2, RUB: 11.1, AUD: 0.21, SGD: 0.19, XXX: 9 }
};

const NOTICES_A = `<ul>
  <li><a href="/1">关于延长部分国家免签政策的通知</a></li>
  <li><a href="/2">过境免签停留时间调整为 240 小时</a></li>
  <li><a href="/3">第三季度出入境数据发布</a></li>
  <li><a href="/4">Home</a></li>
</ul>`;

const NOTICES_B = `<ul>
  <li><a href="/1">关于延长部分国家免签政策的通知</a></li>
  <li><a href="/2">关于新增免签国家的公告</a></li>
  <li><a href="/3">第三季度出入境数据发布</a></li>
</ul>`;

/* ---------------- 天气（双源） ---------------- */

const MET = (temp, symbol) => ({
  properties: {
    timeseries: [
      {
        time: '2026-11-13T07:00:00Z',
        data: {
          instant: { details: { air_temperature: temp, relative_humidity: 61, wind_speed: 4.2 } },
          next_1_hours: { summary: { symbol_code: symbol } }
        }
      }
    ]
  }
});

const isMet = (u) => String(u).includes('met.no');
const isOm = (u) => String(u).includes('open-meteo');

test('天气主源 MET：逐点解析成 6 条，symbol_code 归一为语义分类', async () => {
  live.reset();
  live.configure({
    now: () => CLOCK,
    fetch: (u) => (isMet(u) ? jsonResponse(MET(12.6, 'partlycloudy_day')) : Promise.reject(new Error('should not fall back')))
  });
  const w = await live.getWeather({ force: true });
  assert.equal(w.ok, true);
  assert.equal(w.provider, 'MET Norway');
  assert.equal(w.stale, false);
  assert.equal(w.items.length, 6);
  assert.equal(w.items[0].temp, 13);
  assert.equal(w.items[0].cat, 'cloudy');
  assert.equal(w.items[0].humidity, 61);
});

test('天气主源挂 → 自动切备源 Open-Meteo，性能降级但可用', async () => {
  live.reset();
  live.configure({
    now: () => CLOCK,
    fetch: (u) => (isMet(u) ? Promise.reject(Object.assign(new Error('connect timeout'), { name: 'TimeoutError' })) : jsonResponse(WEATHER))
  });
  const w = await live.getWeather({ force: true });
  assert.equal(w.ok, true);
  assert.equal(w.provider, 'Open-Meteo');
  assert.equal(w.items.length, 6);
  assert.equal(w.items[1].cat, 'cloudy'); // weather_code 3
  assert.equal(w.items[2].cat, 'rain'); // weather_code 61
});

test('天气双源全挂 → 保留上一份好数据并标 stale', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: (u) => (isMet(u) ? jsonResponse(MET(9, 'clearsky_day')) : Promise.reject(new Error('x'))) });
  const good = await live.getWeather({ force: true });
  assert.equal(good.ok, true);

  live.configure({ fetch: () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })) });
  const bad = await live.getWeather({ force: true });
  assert.equal(bad.stale, true);
  assert.equal(bad.ok, true, '有旧数据时仍可用');
  assert.equal(bad.items.length, 6, '旧数据没有被清空');
  assert.equal(bad.error, 'timeout');
});

test('天气：从未成功过 → ok=false，但不抛异常', async () => {
  live.reset();
  live.configure({ fetch: () => Promise.reject(new Error('ENOTFOUND')) });
  const w = await live.getWeather({ force: true });
  assert.equal(w.ok, false);
  assert.equal(w.items.length, 0);
  assert.match(w.error, /met-no|open-meteo/);
});

test('天气：TTL 内命中缓存，不重复请求', async () => {
  let clock = CLOCK;
  let calls = 0;
  live.reset();
  live.configure({
    now: () => clock,
    fetch: (u) => {
      calls += 1;
      return isMet(u) ? jsonResponse(MET(11, 'clearsky_day')) : Promise.reject(new Error('x'));
    }
  });

  await live.getWeather({ force: true });
  const afterFirst = calls;
  await live.getWeather();
  assert.equal(calls, afterFirst, 'TTL 内不应二次请求');

  clock += live.TTL.weather + 1000;
  await live.getWeather();
  assert.ok(calls > afterFirst, '过了 TTL 应该重新请求');
});

test('天气分类：MET symbol 与 WMO 码映射一致（同一语义不会两个名字）', () => {
  const cats = ['clearsky_day', 'partlycloudy_night', 'cloudy', 'fog', 'lightrain', 'rain', 'heavyrain', 'lightsnow', 'snow', 'thunderstorm'];
  const out = cats.map((c) => live.symbolToCat(c));
  assert.deepEqual(out, ['clear', 'cloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'snow', 'storm']);
});

/* ---------------- 汇率 ---------------- */

test('汇率：只保留需要的币种，未知币种不透出', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => jsonResponse(FX) });
  const f = await live.getFx({ force: true });
  assert.equal(f.ok, true);
  assert.equal(f.base, 'CNY');
  assert.equal(f.rates.USD, 0.1385);
  assert.equal(f.rates.XXX, undefined);
  assert.match(f.updatedAt, /2026/);
});

test('汇率：上游返回非 success 视为失败', async () => {
  live.reset();
  live.configure({ fetch: () => jsonResponse({ result: 'error' }) });
  const f = await live.getFx({ force: true });
  assert.equal(f.ok, false);
  assert.ok(f.error);
});

/* ---------------- 政策源监测 ---------------- */

test('政策标题抽取：只留政策相关，且去重', () => {
  const titles = live.extractPolicyTitles(NOTICES_A);
  assert.ok(titles.some((t) => t.includes('免签')));
  assert.equal(titles.includes('Home'), false, '导航项应被过滤');
  assert.equal(new Set(titles).size, titles.length, '标题应去重');
});

test('政策监测：首次建立基线，不报警', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => htmlResponse(NOTICES_A) });
  const p = await live.getPolicyWatch({ force: true });
  assert.equal(p.ok, true);
  assert.equal(p.needsReview, false);
  for (const s of p.sources) assert.ok(['baseline', 'unchanged'].includes(s.status));
});

test('政策监测：内容变化 → 标记 changed + needsReview，但不改任何规则', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => htmlResponse(NOTICES_A) });
  await live.getPolicyWatch({ force: true });

  live.configure({ fetch: () => htmlResponse(NOTICES_B) });
  const p = await live.getPolicyWatch({ force: true });
  assert.equal(p.needsReview, true);
  assert.ok(p.changedCount >= 1);
  assert.equal(p.sources[0].status, 'changed');
  assert.equal(p.sources[0].previousHash.length, 16);
});

test('政策监测：源不可达 → unreachable，不误报「有变化」', async () => {
  live.reset();
  live.configure({ fetch: () => Promise.reject(new Error('ENOTFOUND')) });
  const p = await live.getPolicyWatch({ force: true });
  assert.equal(p.ok, false);
  assert.equal(p.needsReview, false);
  for (const s of p.sources) {
    assert.equal(s.status, 'unreachable');
    assert.equal(s.error, 'ENOTFOUND');
  }
});

/* ---------------- 退税估算 ---------------- */

test('退税估算：仅展示8%至11%扣费前范围，并按有效参考汇率折算', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => jsonResponse(FX) });
  await live.getFx({ force: true });

  const e = live.refundEstimate(10000, 'USD');
  assert.equal(e.refundCNY, null);
  assert.equal(e.refundLocal, null);
  assert.equal(e.feeKnown, false);
  assert.equal(e.grossMinCNY, 800);
  assert.equal(e.grossMaxCNY, 1100);
  assert.equal(e.grossMinLocal, 110.8);
  assert.equal(e.grossMaxLocal, 152.35);
  assert.equal(e.currency, 'USD');
  assert.equal(e.rateStale, false);

  assert.equal(live.refundEstimate(0, 'USD'), null);
  assert.equal(live.refundEstimate('abc', 'USD'), null);
});

test('退税估算：汇率没拿到时只给人民币，不编汇率', async () => {
  live.reset();
  live.configure({ fetch: () => Promise.reject(new Error('offline')) });
  await live.getFx({ force: true });
  const e = live.refundEstimate(1000, 'USD');
  assert.equal(e.refundCNY, null);
  assert.equal(e.grossMinCNY, 80);
  assert.equal(e.grossMaxCNY, 110);
  assert.equal(e.currency, 'USD');
  assert.equal(e.conversionAvailable, false);
  assert.equal(e.grossMinLocal, null);
  assert.equal(e.refundLocal, null);
});

test('无效天气对象与过期观测不能标成正常，雷雨分类优先', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => jsonResponse({ current: {} }) });
  assert.equal((await live.getWeather({ force: true })).ok, false);
  live.configure({ fetch: () => jsonResponse(MET(10, '')) });
  assert.equal((await live.getWeather({ force: true })).ok, false);
  live.configure({ fetch: () => jsonResponse(MET(10, 'clearsky_day')), now: () => CLOCK + 7 * 60 * 60 * 1000 });
  assert.equal((await live.getWeather({ force: true })).ok, false);
  assert.equal(live.symbolToCat('heavyrainandthunder_day'), 'storm');
  assert.equal(live.symbolToCat('sleetshowers_day'), 'snow');
  assert.equal(live.wmoToCat(null), null);
  assert.equal(live.wmoToCat(-1), null);
});

test('空标题不建立或覆盖有效基线，监测降级为stale', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => htmlResponse('<html>captcha</html>') });
  const empty = await live.getPolicyWatch({ force: true });
  assert.equal(empty.ok, false);
  assert.equal(empty.stale, true);
  for (const source of empty.sources) {
    assert.equal(source.hash, null);
    assert.equal(source.status, 'unreachable');
  }
  live.configure({ fetch: () => htmlResponse(NOTICES_A) });
  const good = await live.getPolicyWatch({ force: true });
  const hashes = good.sources.map((s) => s.hash);
  live.configure({ fetch: () => htmlResponse('<html>captcha</html>') });
  const failed = await live.getPolicyWatch({ force: true });
  assert.deepEqual(failed.sources.map((s) => s.previousHash), hashes);
  live.configure({ fetch: () => htmlResponse(NOTICES_A) });
  assert.ok((await live.getPolicyWatch({ force: true })).sources.every((s) => s.status === 'unchanged'));
});

test('汇率拒绝错误基币、负值、过期时间，折算不使用失效或未知汇率', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => jsonResponse({ ...FX, base_code: 'USD' }) });
  assert.equal((await live.getFx({ force: true })).ok, false);
  live.configure({ fetch: () => jsonResponse({ ...FX, rates: { USD: -1, EUR: Infinity } }) });
  assert.equal((await live.getFx({ force: true })).ok, false);
  live.configure({ fetch: () => jsonResponse({ ...FX, time_last_update_utc: '2020-01-01' }) });
  assert.equal((await live.getFx({ force: true })).ok, false);
  live.configure({ fetch: () => jsonResponse(FX) });
  await live.getFx({ force: true });
  assert.equal(live.refundEstimate(1000, 'XXX').grossMinLocal, null);
  assert.equal(live.refundEstimate(1000, 'toString').rateApplied, null);
  live.configure({ now: () => CLOCK + live.TTL.fx + 1 });
  assert.equal(live.refundEstimate(1000, 'USD').grossMaxLocal, null);
  assert.equal(live.refundEstimate(1000, 'CNY').grossMaxLocal, 110);
});

test('汇率刷新失败保留旧数据显示stale，但不得继续折算', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => jsonResponse(FX) });
  await live.getFx({ force: true });
  live.configure({ fetch: () => Promise.reject(new Error('offline')) });
  const result = await live.getFx({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
  assert.equal(result.rates.USD, FX.rates.USD);
  assert.equal(live.refundEstimate(1000, 'USD').rateApplied, null);
  assert.equal(live.refundEstimate(1000, 'USD').rateStale, true);
});

test('并发请求共享一次抓取，失败后短冷却避免轮询放大', async () => {
  live.reset();
  let calls = 0;
  let clock = CLOCK;
  live.configure({ now: () => clock, fetch: async () => { calls++; throw new Error('offline'); } });
  await Promise.all([live.getFx(), live.getFx(), live.getFx()]);
  assert.equal(calls, 1);
  await live.getFx();
  assert.equal(calls, 1);
  clock += 31_000;
  await live.getFx();
  assert.equal(calls, 2);
});

test('状态遵守INBOUND_DATA_DIR，持久化失败显式反映到health', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => htmlResponse(NOTICES_A) });
  await live.getPolicyWatch({ force: true });
  const stateFile = nodePath.join(testDir, 'live-state.json');
  assert.ok(fs.existsSync(stateFile));
  fs.unlinkSync(stateFile);
  fs.mkdirSync(stateFile);
  try {
    const result = await live.getPolicyWatch({ force: true });
    assert.match(result.persistenceError, /persistence failed/);
    assert.equal(live.health().policyWatch.ok, false);
    assert.match(live.health().policyWatch.error, /persistence failed/);
  } finally {
    fs.rmdirSync(stateFile);
  }
});

/* ---------------- 汇总 ---------------- */

test('健康检查给出每个源的状态，不抛异常', async () => {
  live.reset();
  live.configure({ now: () => CLOCK, fetch: () => jsonResponse(WEATHER) });
  await live.snapshot();
  const h = live.health();
  assert.ok(h.weather);
  assert.ok(h.fx);
  assert.ok(h.policyWatch);
  assert.equal(typeof h.needsReview, 'boolean');
});

test('快照在全部源挂掉时仍能返回（产品不能因为第三方挂了就打不开）', async () => {
  live.reset();
  live.configure({ fetch: () => Promise.reject(new Error('offline')) });
  const snap = await live.snapshot();
  assert.ok(snap.serverTime);
  assert.equal(snap.weather.ok, false);
  assert.equal(snap.fx.ok, false);
  assert.equal(snap.policyWatch.ok, false);
});
