'use strict';
const os = require('node:os');
const fs = require('node:fs');
const nodePath = require('node:path');
const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'inbound-smoke-'));
process.env.INBOUND_DATA_DIR = tempDir;
for (const [key, file] of Object.entries({
  LIVE_STATE_FILE: 'live-state.json',
  INBOUND_DB_FILE: 'inbound.sqlite',
  INBOUND_FEEDBACK_FILE: 'feedback.jsonl',
  INBOUND_HISTORY_FILE: 'history.jsonl',
  INBOUND_AUDIT_FILE: 'policy-audit.jsonl'
})) process.env[key] = nodePath.join(tempDir, file);
process.env.INBOUND_STORAGE_MODE = 'sqlite';
process.env.POLICY_ADMIN_TOKEN = 'smoke-only-admin-token';
process.env.QUIET = '1';
delete process.env.INBOUND_REGISTRY_FILE;
const adminHeaders = { 'x-admin-token': process.env.POLICY_ADMIN_TOKEN };
let server;


/**
 * 端到端冒烟：真的起一个 HTTP 服务，按 6 个语种把每个接口打一遍。
 * 实时源在这里被打桩（离线可跑），真实的联网验证交给 `npm run live:check`。
 */

const assert = require('node:assert/strict');
const { createServer } = require('../server/index');
const live = require('../server/live');
const i18n = require('../server/i18n');
const engine = require('../server/policy-engine');
const registry = require('../server/policy-registry');
const store = require('../server/store');
const taxfree = require('../server/taxfree');
const registryData = require('../data/policy-registry.json');
const fixtureNow = new Date();
const shoppingDate = new Date(fixtureNow.getTime() + 8 * 3600000).toISOString().slice(0, 10);

/* ---------------- 实时源打桩 ---------------- */

const WEATHER = Array.from({ length: 6 }, (_, i) => ({
  current: { temperature_2m: 10 + i * 2.3, weather_code: [0, 3, 61, 45, 95, 2][i], relative_humidity_2m: 50, wind_speed_10m: 3 }
}));
const FX = { result: 'success', base_code: 'CNY', time_last_update_utc: fixtureNow.toUTCString(), rates: { USD: 0.1385, EUR: 0.128, JPY: 21.4, KRW: 190.2, RUB: 11.1, GBP: 0.11 } };
const HTML = '<ul><li><a href="/1">关于延长部分国家免签政策的通知</a></li><li><a href="/2">过境免签停留时间调整</a></li></ul>';

const MET = (t, sym) => ({
  properties: {
    timeseries: [
      {
        time: fixtureNow.toISOString(),
        data: {
          instant: { details: { air_temperature: t, relative_humidity: 55, wind_speed: 3 } },
          next_1_hours: { summary: { symbol_code: sym } }
        }
      }
    ]
  }
});

live.reset();
live.configure({
  fetch: (url) => {
    const u = String(url);
    if (u.includes('met.no')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(MET(16.4, 'partlycloudy_day')) });
    if (u.includes('open-meteo')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(WEATHER) });
    if (u.includes('er-api')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(FX) });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(HTML) });
  }
});

/* ---------------- 跑 ---------------- */

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((e) => results.push({ name, ok: false, error: e.message }));
}

async function main() {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (path, headers = {}) => {
    const res = await fetch(base + path, { headers });
    const body = await res.json();
    return { status: res.status, body };
  };
  const post = async (path, payload, headers = {}) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload)
    });
    return { status: res.status, body: await res.json() };
  };

  /* --- 基础设施 --- */
  await check('GET / 返回新版旅行首页，使用可解析的相对资源入口', async () => {
    const res = await fetch(base + '/');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('id="langSel"'));
    assert.ok(html.includes('id="inspiration"'));
    assert.ok(html.includes('id="routeDetail"'));
    const script = html.match(/<script\b[^>]*src="(app\.js[^\"]*)"/);
    assert.ok(script, '缺少应用脚本');
    const asset = await fetch(new URL(script[1], base + '/'));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
  });

  await check('GET /styles.css 与 /app.js 可访问', async () => {
    assert.equal((await fetch(base + '/styles.css')).status, 200);
    assert.equal((await fetch(base + '/app.js')).status, 200);
  });

  await check('GET /api/health 列出 6 个语种与实时源状态', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.deepEqual(body.langs, i18n.CODES);
    assert.ok(body.live.weather);
  });

  await check('GET /api/languages 各语种 coverage.complete 为 true', async () => {
    const { body } = await get('/api/languages');
    assert.equal(body.items.length, 6);
    for (const l of body.items) assert.equal(l.coverage.complete, true, l.code + ' 不完整');
  });

  /* --- 每个语种跑一遍 --- */
  for (const lang of i18n.CODES) {
    await check(`[${lang}] /api/ui 返回完整字典`, async () => {
      const { status, body } = await get(`/api/ui?lang=${lang}`);
      assert.equal(status, 200);
      assert.equal(body.lang, lang);
      assert.ok(Object.keys(body.ui).length >= 170);
      assert.equal(JSON.stringify(body).includes('⟦'), false);
    });

    await check(`[${lang}] /api/meta 政策版本与倒计时`, async () => {
      const { body } = await get(`/api/meta?lang=${lang}`);
      assert.equal(body.policy.version, i18n.pack(lang).policy.version);
      assert.equal(typeof body.policy.countdown.daysUntilExpiry, 'number');
    });

    await check(`[${lang}] /api/countries 国名已本地化`, async () => {
      const { body } = await get(`/api/countries?lang=${lang}`);
      assert.equal(body.version, engine.COUNTRIES.version);
      assert.deepEqual(body.items.map((c) => c.code), engine.COUNTRIES.order);
      assert.equal(body.items.length, Object.keys(engine.COUNTRIES.items).length);
      const de = body.items.find((c) => c.code === 'DE');
      assert.ok(de.name.length > 1);
      assert.notEqual(de.name, 'DE');
      assert.equal(de.flags.unilateral, true);
    });

    await check(`[${lang}] /api/destinations 带实时天气`, async () => {
      const { body } = await get(`/api/destinations?lang=${lang}`);
      assert.equal(body.items.length, 6);
      assert.equal(body.live.ok, true);
      assert.equal(typeof body.items[0].weather.temp, 'number');
      assert.ok(['clear', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm'].includes(body.items[0].weather.cat));
    });

    await check(`[${lang}] /api/questions 7 条、文案非空`, async () => {
      const { body } = await get(`/api/questions?lang=${lang}`);
      assert.equal(body.items.length, 7);
      for (const q of body.items) assert.ok(q.q.length > 3);
    });

    await check(`[${lang}] /api/policy 三数字五步`, async () => {
      const { body } = await get(`/api/policy?lang=${lang}`);
      assert.equal(body.stats.length, 3);
      assert.equal(body.steps.length, 5);
      assert.equal(body.countdown.daysUntilExpiry, contentDays(body.countdown.expires));
    });

    await check(`[${lang}] POST /api/eligibility 出结论`, async () => {
      const { status, body } = await post(`/api/eligibility?lang=${lang}`, {
        countryCode: 'DE',
        purpose: 'tour',
        stayDays: 10,
        port: 'PVG',
        next: 'home'
      });
      assert.equal(status, 200);
      const verdict = engine.evaluate({ countryCode: 'DE', purpose: 'tour', stayDays: 10, port: 'PVG', next: 'home' });
      const gate = registry.guard(new Date(), { ruleIds: registry.ruleIdsForVerdict(verdict) });
      assert.equal(body.code, gate.ok ? verdict.code : 'X');
      if (!gate.ok) assert.equal(body.blocked, true);
      assert.ok(body.title.length > 2);
      assert.ok(body.why.length > 20);
      assert.equal(body.meta.i18n.lang, lang);
      assert.equal(JSON.stringify(body).includes('⟦'), false);
    });

    await check(`[${lang}] POST /api/ask 走规则库`, async () => {
      const { body } = await post(`/api/ask?lang=${lang}`, { id: 'visa' });
      assert.equal(body.type, 'answer');
      assert.equal(body.item.id, 'visa');
      assert.equal(body.meta.mode, 'rules');
      assert.ok(body.item.a.length > 10);
    });

    await check(`[${lang}] POST /api/taxfree 算期限 + 汇率估算`, async () => {
      const { body } = await post(`/api/taxfree?lang=${lang}`, {
        shoppingDate,
        amount: 10000,
        currency: 'USD'
      });
      assert.equal(body.route, 'port');
      assert.equal(body.deadline, new Date(Date.parse(shoppingDate + 'T00:00:00Z') + 90 * 86400000).toISOString().slice(0, 10));
      assert.equal(body.windowDays, taxfree.WINDOW_DAYS);
      assert.equal(body.daysLeft, 90);
      assert.equal(body.estimate.grossMinCNY, 800);
      assert.equal(body.estimate.grossMaxCNY, 1100);
      assert.ok(body.estimate.grossMinLocal > 0);
      assert.ok(body.estimate.grossMaxLocal > body.estimate.grossMinLocal);
      assert.equal(body.estimate.feeKnown, false);
      assert.equal(body.estimate.refundCNY, null);
      assert.equal(body.estimate.refundLocal, null);
    });
  }

  /* --- 跨语种与边界 --- */
  await check('同一输入在三种语言下给出不同措辞、同一结论', async () => {
    const payload = { countryCode: 'US', purpose: 'tr', next: 'home' };
    const en = (await post('/api/eligibility?lang=en', payload)).body;
    const ja = (await post('/api/eligibility?lang=ja', payload)).body;
    const zh = (await post('/api/eligibility?lang=zh', payload)).body;
    assert.equal(en.code, ja.code);
    assert.equal(en.code, zh.code);
    assert.notEqual(en.title, ja.title);
    assert.notEqual(en.why, zh.why);
  });

  await check('Accept-Language 协商生效（不带 ?lang）', async () => {
    const { body } = await get('/api/ui', { 'Accept-Language': 'ko-KR,ko;q=0.9' });
    assert.equal(body.lang, 'ko');
  });

  await check('未知语种回退英文而不是报错', async () => {
    const { status, body } = await get('/api/ui?lang=xx');
    assert.equal(status, 200);
    assert.equal(body.lang, 'en');
  });

  await check('英文关键词在日语界面下仍能命中', async () => {
    const { body } = await post('/api/ask?lang=ja', { text: 'how to pay with a foreign card' });
    assert.equal(body.type, 'answer');
    assert.equal(body.item.id, 'payment');
  });

  await check('答不出来时明确兜底并给建议列表', async () => {
    const { body } = await post('/api/ask?lang=ru', { text: 'zzzz qqqq' });
    assert.equal(body.type, 'fallback');
    assert.ok(body.fallback.length > 20);
    assert.equal(body.suggestions.length, 7);
  });

  await check('非法入参返回 400 + 字段名（不猜）', async () => {
    const { status, body } = await post('/api/eligibility?lang=en', { countryCode: 'DE', stayDays: 999 });
    assert.equal(status, 400);
    assert.equal(body.error, 'ValidationError');
    assert.equal(body.field, 'stayDays');
  });

  await check('GET /api/nope 返回 JSON 404，不落回 HTML', async () => {
    const { status, body } = await get('/api/nope');
    assert.equal(status, 404);
    assert.equal(body.error, 'NotFound');
  });

  await check('GET /api/eligibility 不被静态文件分支吞掉', async () => {
    const { status, body } = await get('/api/eligibility');
    assert.equal(status, 404);
    assert.equal(body.error, 'NotFound');
  });

  await check('反馈落库并按语种统计（6 语种不能被压成中英两种）', async () => {
    const before = (await get('/api/stats', adminHeaders)).body;
    assert.equal((await post('/api/feedback', { answerId: 'visa', helpful: true, lang: 'ja' })).status, 201);
    assert.equal((await post('/api/feedback', { answerId: 'payment', helpful: false, lang: 'ru' })).status, 201);
    const { status, body } = await get('/api/stats', adminHeaders);
    assert.equal(status, 200);
    assert.equal(body.total, before.total + 2);
    assert.equal(body.byLang.ja.helpful, (before.byLang.ja?.helpful || 0) + 1);
    assert.equal(body.byLang.ru.unhelpful, (before.byLang.ru?.unhelpful || 0) + 1);
  });

  await check('健康检查带存储模式与政策状态', async () => {
    const { body } = await get('/api/health');
    assert.equal(body.storage.mode, 'sqlite');
    assert.equal(body.storage.writable, true);
    assert.ok(['ok', 'review', 'expired'].includes(body.policy.status));
    assert.deepEqual(Object.keys(body.storage).sort(), ['mode', 'writable']);
    assert.ok(store.health().counts.feedback >= 1);
  });

  await check('政策台账与受控数据一致，每条都有失效日口径与来源', async () => {
    const { body } = await get('/api/policy/health');
    assert.equal(body.counts.total, registryData.rules.length);
    assert.equal(body.version, registryData.version);
    assert.ok(body.rules.every((r) => r.id && r.authority && r.sourceUrl && r.reviewDue));
    assert.ok(body.rules.some((r) => r.expiresOn === '2026-12-31'));
    assert.ok(body.rules.some((r) => r.expiresOn === null), '无期限规则必须显式为 null');
    assert.match(body.sourceModel, /无官方结构化 API/);
  });

  await check('运维接口拒绝无令牌和 body.token', async () => {
    assert.equal((await get('/api/stats')).status, 403);
    assert.equal((await get('/api/policy/audit')).status, 403);
    const { status, body } = await post('/api/policy/ack', { ruleIds: ['unilateral-50'], token: process.env.POLICY_ADMIN_TOKEN });
    assert.equal(status, 403);
    assert.equal(body.error, 'Forbidden');
    assert.equal((await post('/api/live/refresh', { source: 'fx', token: process.env.POLICY_ADMIN_TOKEN })).status, 403);
  });

  await check('旧 sid 历史接口固定关闭，判定不写私人记录', async () => {
    const sid = 'wsmoke1234567';
    const before = store.health().counts.history;
    const j = await post('/api/eligibility?lang=ja', { countryCode: 'DE', purpose: 'tour', stayDays: 10, sid });
    assert.equal(j.status, 200);
    const { status, body } = await get('/api/history?sid=' + sid);
    assert.equal(status, 410);
    assert.equal(body.error, 'LegacyHistoryDisabled');
    assert.equal(body.items, undefined);
    assert.equal(store.health().counts.history, before);
    assert.deepEqual(store.getHistory(sid).items, []);
  });

  await check('CSP 去掉脚本 unsafe-inline，页面无内联事件', async () => {
    const res = await fetch(base + '/');
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
    const html = await res.text();
    assert.ok(!/onclick=|onchange=|oninput=|onkeydown=/.test(html));
  });

  await check('GET /api/live 聚合三个实时源', async () => {
    const { body } = await get('/api/live');
    assert.equal(body.weather.ok, true);
    assert.equal(body.fx.ok, true);
    assert.ok(Array.isArray(body.policyWatch.sources));
    assert.ok(body.serverTime);
  });

  await check('POST /api/live/refresh 可强制刷新', async () => {
    const { status, body } = await post('/api/live/refresh', { source: 'fx' }, adminHeaders);
    assert.equal(status, 200);
    assert.deepEqual(body.refreshed, ['fx']);
  });

  await check('内容安全响应头存在', async () => {
    const res = await fetch(base + '/');
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  /* --- 汇总 --- */

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.ok ? '' : '  →  ' + r.error}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

function contentDays(expires) {
  const beijing = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return Math.round((Date.parse(expires + 'T00:00:00Z') - Date.parse(beijing + 'T00:00:00Z')) / 86400000);
}

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exitCode = 1;
}).finally(async () => {
  if (server?.listening) await new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeIdleConnections();
  });
  store.reset();
  live.reset();
  fs.rmSync(tempDir, { recursive: true, force: true });
}).catch((e) => {
  console.error('smoke cleanup failed:', e);
  process.exitCode = 1;
});
