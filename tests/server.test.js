'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = 'server-test-admin-token';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/policy-registry.json'), 'utf8'));
const childSource = `
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const indexFile = process.env.TEST_ROOT + '/server/index.js';
  const instance = { exports: {} };
  new Function('require', 'module', '__dirname', fs.readFileSync(indexFile, 'utf8'))(
    createRequire(indexFile), instance, path.join(path.dirname(process.env.TEST_PUBLIC_DIR), 'server'));
  const { createServer } = instance.exports;
  const store = require(process.env.TEST_ROOT + '/server/store');
  const live = require(process.env.TEST_ROOT + '/server/live');
  live.reset();
  live.configure({ fetch: async () => ({ ok: true, status: 200, json: async () => ({
    result: 'success', base_code: 'CNY', time_last_update_utc: new Date().toUTCString(),
    rates: Object.fromEntries(['USD', 'EUR', 'GBP', 'JPY', 'KRW', 'RUB', 'AUD', 'CAD', 'SGD', 'HKD', 'THB', 'MYR'].map((code) => [code, 0.14]))
  }), text: async () => '<a href="/test">test fixture</a>' }) });
  let weatherCalls = 0;
  live.getWeather = async () => {
    fs.writeFileSync(process.env.TEST_WEATHER_CALLS_FILE, String(++weatherCalls));
    return { ok: true, stale: false, items: [], fetchedAt: Date.now(), source: 'fixture-weather', error: null };
  };
  if (process.env.TEST_NULL_ESTIMATOR === '1') live.refundEstimate = () => null;
  store.health();
  if (process.env.TEST_WRITE_FAILURE === '1') {
    fs.renameSync(process.env.INBOUND_FEEDBACK_FILE, process.env.INBOUND_FEEDBACK_FILE + '.saved');
    fs.mkdirSync(process.env.INBOUND_FEEDBACK_FILE);
  }
  const server = createServer();
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.on('message', (message) => {
    if (message === 'close') {
      server.close(() => { store.reset(); process.disconnect(); });
      server.closeIdleConnections();
    }
  });
`;

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-server-test-'));
  const publicDir = path.join(dir, 'public');
  fs.cpSync(path.join(ROOT, 'public'), publicDir, { recursive: true });
  const registry = structuredClone(FIXTURE);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  for (const rule of registry.rules) {
    if (rule.status === 'retired') continue;
    if (rule.id !== 'mutual-agreements') rule.status = 'active';
    rule.effectiveFrom = '2000-01-01';
    rule.expiresOn = future;
    rule.reviewDue = future;
  }
  const ruleId = options.ruleId || (options.taxOnly ? 'taxfree-port-90' : 'unilateral-50');
  if (options.ruleStatus === 'missing') {
    assert.ok(registry.rules.some((rule) => rule.id === ruleId), '夹具应包含待移除规则：' + ruleId);
    registry.rules = registry.rules.filter((rule) => rule.id !== ruleId);
  } else if (options.ruleStatus) {
    const rule = registry.rules.find((rule) => rule.id === ruleId);
    assert.ok(rule, '夹具应包含待测规则');
    rule.status = options.ruleStatus;
    if (options.ruleStatus === 'expired') rule.expiresOn = '2000-01-02';
    if (options.ruleStatus === 'needs_review') rule.reviewDue = today;
  }
  if (options.transformRules) options.transformRules(registry.rules);
  const registryFile = path.join(dir, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  const blocker = path.join(dir, 'not-a-directory');
  if (options.unavailable) fs.writeFileSync(blocker, 'fixture');
  const env = {
    ...process.env,
    TEST_ROOT: ROOT,
    TEST_PUBLIC_DIR: publicDir,
    TEST_WRITE_FAILURE: options.writeFailure ? '1' : '0',
    TEST_NULL_ESTIMATOR: options.nullEstimator ? '1' : '0',
    TEST_WEATHER_CALLS_FILE: path.join(dir, 'weather-calls.txt'),
    POLICY_ADMIN_TOKEN: options.admin === false ? '' : ADMIN,
    TRUST_PROXY: options.trustProxy ? '1' : '0',
    PUBLIC_ORIGIN: options.publicOrigin || '',
    QUIET: '1',
    INBOUND_DATA_DIR: dir,
    INBOUND_DB_FILE: path.join(options.unavailable ? blocker : dir, 'inbound.sqlite'),
    INBOUND_FEEDBACK_FILE: path.join(dir, 'feedback.jsonl'),
    INBOUND_HISTORY_FILE: path.join(dir, 'history.jsonl'),
    INBOUND_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
    INBOUND_REGISTRY_FILE: registryFile,
    INBOUND_STORAGE_MODE: options.mode || 'sqlite',
    LIVE_STATE_FILE: path.join(dir, 'live-state.json')
  };
  const child = fork('-e', [childSource], { env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stdout.on('data', (data) => { diagnostics += data; });
  child.stderr.on('data', (data) => { diagnostics += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('测试服务未正常关闭：' + diagnostics)); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send('close');
        else child.kill();
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试服务未启动：' + diagnostics)), 5000);
    child.once('message', (message) => { clearTimeout(timer); resolve(message.port); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`测试子进程退出 ${code}：${diagnostics}`)); });
  });
  return {
    dir,
    publicDir,
    request: (pathname, options = {}) => new Promise((resolve, reject) => {
      const body = options.raw !== undefined ? options.raw : options.body === undefined ? undefined : JSON.stringify(options.body);
      const req = http.request({
        host: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }), ...options.headers }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { /* 静态响应和 HEAD 不含 JSON。 */ }
          resolve({ status: res.statusCode, headers: res.headers, text, body: json });
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('测试请求超时')));
      req.end(body);
    })
  };
}

const payload = { countryCode: 'DE', purpose: 'tour', stayDays: 10, port: 'PVG', next: 'home' };
const feedback = { answerId: 'visa', helpful: true, lang: 'ja' };
const adminHeaders = { 'x-admin-token': ADMIN };

test('管理员未配置时所有运维入口关闭', async (t) => {
  const { request } = await fixture(t, { admin: false });
  for (const [url, method] of [['/api/stats', 'GET'], ['/api/policy/audit', 'GET'], ['/api/policy/ack', 'POST'], ['/api/live/refresh', 'POST']]) {
    const res = await request(url, { method, headers: adminHeaders, ...(method === 'POST' ? { body: { token: ADMIN } } : {}) });
    assert.equal(res.status, 503, url);
    assert.equal(res.body.error, 'AdminDisabled');
  }
});

test('管理员令牌仅认可请求头，不接受正文或查询参数', async (t) => {
  const { request } = await fixture(t);
  for (const url of ['/api/stats', '/api/policy/audit']) {
    assert.equal((await request(url)).status, 403);
    assert.equal((await request(url + '?token=' + ADMIN)).status, 403);
    assert.equal((await request(url, { headers: { 'x-admin-token': 'wrong' } })).status, 403);
    assert.equal((await request(url, { headers: adminHeaders })).status, 200);
  }
  for (const url of ['/api/live/refresh', '/api/policy/ack']) {
    assert.equal((await request(url, { method: 'POST', body: { token: ADMIN, source: 'fx' } })).status, 403);
  }
  const refresh = await request('/api/live/refresh', { method: 'POST', body: { source: 'fx' }, headers: adminHeaders });
  assert.equal(refresh.status, 200);
  assert.deepEqual(refresh.body.refreshed, ['fx']);
});

test('反馈严格校验白名单和布尔值，只有持久化后返回 201', async (t) => {
  const { request } = await fixture(t);
  const before = (await request('/api/stats', { headers: adminHeaders })).body.total;
  for (const invalid of [{ helpful: 'false' }, { helpful: 1 }, { helpful: null }, { answerId: 'unknown' }, { answerId: { id: 'visa' } }, { lang: 'xx' }, { lang: 'JA' }]) {
    assert.equal((await request('/api/feedback', { method: 'POST', body: { ...feedback, ...invalid } })).status, 400);
  }
  assert.equal((await request('/api/stats', { headers: adminHeaders })).body.total, before);
  const valid = await request('/api/feedback', { method: 'POST', body: feedback });
  assert.equal(valid.status, 201);
  assert.equal(valid.body.persisted, true);
  assert.equal((await request('/api/stats', { headers: adminHeaders })).body.total, before + 1);
});

for (const options of [{ mode: 'memory' }, { unavailable: true }, { mode: 'file', writeFailure: true }]) {
  test(`存储异常不伪报反馈成功：${JSON.stringify(options)}`, async (t) => {
    const { request } = await fixture(t, options);
    const res = await request('/api/feedback', { method: 'POST', body: feedback });
    assert.equal(res.status, 503);
    assert.equal(res.body.persisted, false);
    assert.equal(res.body.error, 'StorageUnavailable');
    const health = await request('/api/health');
    assert.deepEqual(Object.keys(health.body.storage).sort(), ['mode', 'writable']);
    assert.equal(health.body.storage.writable, false);
  });
}

test('旧历史接口固定 410，客户端 sid 不会生成本地历史', async (t) => {
  const { request, dir } = await fixture(t, { mode: 'file' });
  const sid = 'server-test-sid';
  assert.equal((await request('/api/eligibility', { method: 'POST', body: { ...payload, sid } })).status, 200);
  for (const suffix of ['', '?sid=' + sid, '?sid=another-test-sid']) {
    const res = await request('/api/history' + suffix);
    assert.equal(res.status, 410);
    assert.equal(res.body.error, 'LegacyHistoryDisabled');
    assert.equal(res.body.items, undefined);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8'), '');
});

for (const ruleStatus of ['expired', 'needs_review', 'missing']) {
  test(`仅本路线失效、待复核或缺失时暂停结论：${ruleStatus}`, async (t) => {
    const { request } = await fixture(t, { ruleStatus });
    const blocked = await request('/api/eligibility', { method: 'POST', body: payload });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.code, 'X');
    assert.equal(blocked.body.blocked, true);
    const unaffected = await request('/api/eligibility', { method: 'POST', body: { ...payload, countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 5 } });
    assert.equal(unaffected.status, 200);
    assert.notEqual(unaffected.body.code, 'X');
    assert.notEqual(unaffected.body.blocked, true);
    const invalid = await request('/api/eligibility', { method: 'POST', body: { ...payload, stayDays: 999 } });
    assert.equal(invalid.status, 400, '引擎校验必须先于状态闸门');
  });
}

for (const ruleStatus of ['active', 'needs_review']) {
  test(`资格接口展开规则全部来源并保留各自标题：${ruleStatus}`, async (t) => {
    const { request } = await fixture(t, { ruleId: 'transit-240', ruleStatus,
      transformRules(rules) {
        for (const id of ['transit-240', 'hainan-30']) {
          const rule = rules.find((item) => item.id === id);
          rule.status = ruleStatus;
          rule.sources.push({ ...rule.sources[0], document: '重复来源不覆盖原标题' });
        }
      } });
    for (const [ruleId, body] of [
      ['transit-240', { ...payload, countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 5 }],
      ['hainan-30', { ...payload, countryCode: 'US', port: 'HAK' }]
    ]) {
      const res = await request('/api/eligibility', { method: 'POST', body });
      assert.equal(res.status, 200);
      assert.equal(res.body.blocked === true, ruleStatus === 'needs_review');
      assert.deepEqual(res.body.sources, FIXTURE.rules.find((rule) => rule.id === ruleId).sources
        .map((source) => ({ id: ruleId, ...source })));
    }
  });
}

test('资格接口人工复核使用实际新链接，不能把旧公告标题贴到新证据上', async (t) => {
  const { request } = await fixture(t, { ruleId: 'transit-240', ruleStatus: 'needs_review', mode: 'file' });
  const sourceUrl = 'https://www.nia.gov.cn/notices/test-notice.html';
  const checkedOn = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const reviewDue = new Date(Date.now() + 7 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const ack = await request('/api/policy/ack', { method: 'POST', headers: adminHeaders,
    body: { ruleIds: ['transit-240'], evidence: [{ ruleId: 'transit-240', sourceUrl, checkedOn, reviewDue }] } });
  assert.equal(ack.status, 200);
  const res = await request('/api/eligibility', { method: 'POST',
    body: { ...payload, countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 5 } });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.blocked, true);
  assert.deepEqual(res.body.sources, [{ id: 'transit-240', url: sourceUrl, document: null }]);
  assert.equal(ack.body.health.rules.find((rule) => rule.id === 'mutual-agreements').status, 'needs_review');
});

test('拦截退税展开多规则来源，跨规则按 URL 去重并保留首个文档标题', async (t) => {
  const sources = FIXTURE.rules.filter((rule) => rule.id.startsWith('taxfree-'))
    .map((rule) => ({ url: rule.sourceUrl, document: rule.document }));
  const { request } = await fixture(t, { taxOnly: true, ruleStatus: 'needs_review', transformRules(rules) {
    rules.find((rule) => rule.id === 'taxfree-port-90').sources = [sources[0], sources[0], sources[1]];
    rules.find((rule) => rule.id === 'taxfree-instant-28').sources = [{ ...sources[1], document: '重复项' }];
  } });
  const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, route: 'instant' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.blocked, true);
  assert.equal(res.body.eligibilityConfirmed, false);
  assert.equal(res.body.deadline, null);
  assert.deepEqual(res.body.sources, sources);
});

test('资格和拦截退税缺失或损坏来源时安全返回，不合成无效链接', async (t) => {
  const { request } = await fixture(t, { taxOnly: true, ruleStatus: 'needs_review', transformRules(rules) {
    const transit = rules.find((rule) => rule.id === 'transit-240');
    const hainan = rules.find((rule) => rule.id === 'hainan-30');
    const port = rules.find((rule) => rule.id === 'taxfree-port-90');
    const instant = rules.find((rule) => rule.id === 'taxfree-instant-28');
    transit.sources = [null, {}, { url: '' }, { url: ' ' }, { url: 42 }, transit.sources[1]];
    hainan.status = 'needs_review';
    delete hainan.sources;
    delete hainan.sourceUrl;
    port.sources = {};
    delete port.sourceUrl;
    instant.sources = [];
  } });
  for (const [body, expected] of [
    [{ ...payload, countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 5 },
      [{ id: 'transit-240', ...FIXTURE.rules.find((rule) => rule.id === 'transit-240').sources[1] }]],
    [{ ...payload, countryCode: 'US', port: 'HAK' }, []]
  ]) {
    const res = await request('/api/eligibility', { method: 'POST', body });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.sources, expected);
    assert.equal(res.body.blocked === true, body.port === 'HAK');
  }
  const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const tax = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, route: 'instant' } });
  assert.equal(tax.status, 200);
  assert.equal(tax.body.blocked, true);
  assert.deepEqual(tax.body.sources, []);
  const fallback = await request('/api/eligibility', { method: 'POST', body: { ...payload, countryCode: 'RU' } });
  const rule = FIXTURE.rules.find((item) => item.id === 'unilateral-russia');
  assert.equal(fallback.status, 200);
  assert.deepEqual(fallback.body.sources, [{ id: rule.id, url: rule.sourceUrl, document: rule.document }]);
});

test('退税规则过期不拦截签证路线', async (t) => {
  const { request } = await fixture(t, { ruleStatus: 'expired', taxOnly: true });
  const res = await request('/api/eligibility', { method: 'POST', body: payload });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'A');
  assert.notEqual(res.body.blocked, true);
});

test('退税路由使用请求正文，口岸默认 90 天，即买即退不擅自推算协议截止日', async (t) => {
  const { request } = await fixture(t);
  const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const port = await request('/api/taxfree', { method: 'POST', body: { shoppingDate } });
  assert.equal(port.status, 200);
  assert.equal(port.body.route, 'port');
  assert.equal(port.body.windowDays, 90);
  assert.equal(port.body.daysLeft, 90);
  const moduleSources = FIXTURE.rules.filter((rule) => rule.id.startsWith('taxfree-'))
    .map((rule, index) => ({ url: rule.sourceUrl, publishedAt: index === 0 ? '2026-02-25' : '2026-05-12' }));
  assert.deepEqual(port.body.sources, moduleSources, '正常退税保留模块的具体来源，不回退首页');
  const instant = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, route: 'instant' } });
  assert.equal(instant.status, 200);
  assert.equal(instant.body.route, 'instant');
  assert.equal(instant.body.deadline, null);
  assert.equal(instant.body.status, 'needs_agreement');
  assert.deepEqual(instant.body.sources, moduleSources);
  const agreementDeadline = new Date(Date.parse(shoppingDate + 'T00:00:00Z') + 10 * 86400000).toISOString().slice(0, 10);
  const agreement = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, route: 'instant', agreementDate: shoppingDate, agreementDeadline } });
  assert.equal(agreement.status, 200);
  assert.equal(agreement.body.deadline, agreementDeadline);
  assert.equal(agreement.body.deadlineBasis, 'user_supplied_agreement');
  assert.equal(agreement.body.daysLeft, 10);
  const invalid = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, route: 'invalid' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.field, 'route');
});

test('退税 amount 严格拒绝类型强转、负数和超过十亿的数值', async (t) => {
  const { request } = await fixture(t);
  const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  for (const amount of ['200', '0', ' ', true, false, [], [200], {}, -1, -0.01, 1000000001, Number.MAX_VALUE]) {
    const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount } });
    assert.equal(res.status, 400, JSON.stringify(amount));
    assert.equal(res.body.error, 'ValidationError');
    assert.equal(res.body.field, 'amount');
    assert.equal(res.body.estimate, undefined);
  }
  const nonFinite = await request('/api/taxfree', { method: 'POST', raw: JSON.stringify({ shoppingDate }).replace(/}$/, ',"amount":1e999}') });
  assert.equal(nonFinite.status, 400);
  assert.equal(nonFinite.body.field, 'amount');
  for (const amount of [0, 0.01, 200, 1000000000]) {
    const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount, currency: 'CNY' } });
    assert.equal(res.status, 200, String(amount));
    assert.notEqual(res.body.blocked, true);
    if (amount === 0) assert.equal(res.body.estimate, undefined);
    else {
      assert.equal(res.body.estimate.purchaseCNY, amount);
      assert.equal(res.body.estimate.feeKnown, false);
      assert.equal(res.body.estimate.refundCNY, null, '不得将扣费前范围伪称实际净退税额');
      assert.equal(res.body.estimate.refundLocal, null);
    }
  }
});

test('退税 amount 空字符串也是字符串，不能绕过严格金额类型校验', async (t) => {
  const { request } = await fixture(t);
  const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount: '' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ValidationError');
  assert.equal(res.body.field, 'amount');
});

test('退税 currency 仅接受明确白名单，不隐式大小写转换或对象取值', async (t) => {
  const { request } = await fixture(t);
  const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  for (const currency of ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'RUB', 'AUD', 'CAD', 'SGD', 'HKD', 'THB', 'MYR']) {
    const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount: 200, currency } });
    assert.equal(res.status, 200, currency);
    assert.notEqual(res.body.blocked, true);
    assert.equal(res.body.estimate.currency, currency);
    assert.equal(res.body.estimate.conversionAvailable, true);
  }
  for (const currency of ['usd', 'USD ', '', 'BTC', '__proto__', 'constructor', null, true, 1, [], ['USD'], {}]) {
    const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount: 200, currency } });
    assert.equal(res.status, 400, JSON.stringify(currency));
    assert.equal(res.body.error, 'ValidationError');
    assert.equal(res.body.field, 'currency');
  }
  const defaultCurrency = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount: 200 } });
  assert.equal(defaultCurrency.status, 200);
  assert.equal(defaultCurrency.body.estimate.currency, 'USD');
});

test('退税估算器返回 null 时安全拒绝且服务仍正常响应', async (t) => {
  const { request } = await fixture(t, { nullEstimator: true });
  const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount: 200, currency: 'USD' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ValidationError');
  assert.equal(res.body.field, 'amount');
  assert.equal(res.body.estimate, undefined);
  assert.equal((await request('/api/health')).status, 200);
});

for (const ruleId of ['taxfree-port-90', 'taxfree-instant-28']) {
  for (const ruleStatus of ['expired', 'needs_review', 'retired', 'missing']) {
    test(`退税路线依赖严格隔离并在缺规则时关闭：${ruleId}/${ruleStatus}`, async (t) => {
      const { request } = await fixture(t, { ruleId, ruleStatus });
      const shoppingDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      for (const route of ['port', 'instant']) {
        const res = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, route, amount: 200 } });
        assert.equal(res.status, 200);
        assert.equal(res.body.route, route);
        const blocked = ruleId === 'taxfree-port-90' || route === 'instant';
        if (blocked) {
          assert.equal(res.body.blocked, true);
          assert.equal(res.body.eligibilityConfirmed, false);
          assert.equal(res.body.status, 'policy_unavailable');
          assert.equal(res.body.deadline, null);
          assert.equal(res.body.daysLeft, null);
          assert.equal(res.body.estimate, undefined);
        } else {
          assert.notEqual(res.body.blocked, true, '口岸路线不得依赖即买即退规则');
          assert.equal(res.body.windowDays, 90);
          assert.equal(res.body.daysLeft, 90);
          assert.ok(res.body.estimate);
        }
      }
      const invalid = await request('/api/taxfree', { method: 'POST', body: { shoppingDate, amount: '200' } });
      assert.equal(invalid.status, 400, '金额校验必须先于规则闸门');
      assert.equal(invalid.body.field, 'amount');
    });
  }
}

test('weather=0 首屏不调用天气，常规请求仍调用天气', async (t) => {
  const { request, dir } = await fixture(t);
  const counter = path.join(dir, 'weather-calls.txt');
  const first = await request('/api/destinations?weather=0');
  assert.equal(first.status, 200);
  assert.ok(first.body.items.length > 0);
  assert.ok(first.body.items.every((item) => item.weather === null));
  assert.deepEqual(first.body.live, { ok: false, stale: true, fetchedAt: null, source: null, error: null });
  assert.equal(fs.existsSync(counter), false, '首屏禁止调用 getWeather，而非仅忽略返回值');
  const regular = await request('/api/destinations');
  assert.equal(regular.status, 200);
  assert.equal(regular.body.live.source, 'fixture-weather');
  assert.equal(fs.readFileSync(counter, 'utf8'), '1');
  assert.equal((await request('/api/destinations?weather=0&lang=ja')).status, 200);
  assert.equal(fs.readFileSync(counter, 'utf8'), '1');
});

test('JSON 类型、损坏正文、超长正文及跨域写请求安全拒绝', async (t) => {
  const { request } = await fixture(t);
  for (const raw of ['{', '[]', 'null', '"text"', '42']) {
    assert.equal((await request('/api/feedback', { method: 'POST', raw })).status, 400, raw);
  }
  assert.equal((await request('/api/feedback', { method: 'POST', body: feedback, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/feedback', { method: 'POST', raw: JSON.stringify({ text: 'x'.repeat(33 * 1024) }) })).status, 413);
  const crossOrigin = await request('/api/feedback', { method: 'POST', body: feedback, headers: { origin: 'https://attacker.invalid' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error, 'CrossOriginDenied');
  assert.equal((await request('/api/health')).status, 200, '异常输入后服务仍可响应');
});

test('受控托管：TRUST_PROXY 下只放行显式配置的公网 Origin', async (t) => {
  const { request } = await fixture(t, { trustProxy: true, publicOrigin: 'https://public.example' });
  const allowed = await request('/api/feedback', { method: 'POST', body: feedback, headers: { origin: 'https://public.example' } });
  assert.ok([200, 201, 202].includes(allowed.status), `配置的公网 Origin 应放行，实际 ${allowed.status}`);
  const denied = await request('/api/feedback', { method: 'POST', body: feedback, headers: { origin: 'https://attacker.invalid' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'CrossOriginDenied');
});

test('静态路径拒绝编码穿越、邻接目录和符号链接逃逸', async (t) => {
  const { request, dir, publicDir } = await fixture(t);
  const secret = path.join(dir, 'private.json');
  fs.writeFileSync(secret, '{"secret":"fixture-only"}');
  const link = path.join(publicDir, 'server-test-link.json');
  fs.symlinkSync(secret, link);
  for (const url of ['/%2e%2e%2fdata%2fcountries.json', '/%2e%2e%2fpublic-neighbor%2fprivate.json', '/' + path.basename(link)]) {
    const res = await request(url);
    assert.equal(res.status, 403, url);
    assert.doesNotMatch(res.text, /fixture-only/);
  }
  for (const url of ['/%', '/%00', '/%5c..%5cdata%5ccountries.json']) {
    assert.equal((await request(url)).status, 400, url);
  }
  assert.equal((await request('/api/no-such-route')).status, 404);
});

test('URL 解析不依赖 Host，非法请求目标返回 400', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/health', { headers: { host: '[malformed' } })).status, 200);
  for (const url of ['//example.invalid/api/health', 'http://example.invalid/api/health', '*']) {
    const res = await request(url);
    assert.equal(res.status, 400, url);
    assert.equal(res.body.error, 'InvalidURL');
  }
});

test('HEAD、静态 MIME 和严格 CSP 保持正确', async (t) => {
  const { request } = await fixture(t);
  const get = await request('/');
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.match(head.headers['content-type'], /^text\/html/);
  assert.match((await request('/app.js')).headers['content-type'], /^text\/javascript/);
  assert.match((await request('/styles.css')).headers['content-type'], /^text\/css/);
  assert.match((await request('/api/health')).headers['content-type'], /^application\/json/);
  const csp = get.headers['content-security-policy'];
  const directives = Object.fromEntries(csp.split(';').map((s) => s.trim().split(/\s+/)).filter((a) => a[0]).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives['script-src'], ["'self'", 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js']);
  assert.deepEqual(directives['connect-src'], ["'self'", 'https://china-trip-assistant.app.workbuddy.host']);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.doesNotMatch(get.text, /\bon(?:click|change|input|keydown)\s*=/i);
});

for (const trustProxy of [false, true]) {
  test(`HSTS 仅显式信任代理时使用代理协议头：${trustProxy}`, async (t) => {
    const { request } = await fixture(t, { trustProxy });
    const plain = await request('/');
    assert.equal(plain.headers['strict-transport-security'], undefined);
    const forwarded = await request('/', { headers: { 'x-forwarded-proto': 'https' } });
    if (trustProxy) assert.match(forwarded.headers['strict-transport-security'], /^max-age=/);
    else assert.equal(forwarded.headers['strict-transport-security'], undefined);
  });
}
