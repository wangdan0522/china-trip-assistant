'use strict';

/** 政策有效期台账：过期自动停判定、变化只标复核、人工确认后恢复。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../server/policy-registry');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { evaluate, COUNTRIES } = require('../server/policy-engine');
const REGISTRY_DATA = require('../data/policy-registry.json');

function reviewEvidence(ruleId, overrides = {}) {
  return { ruleId, sourceUrl: 'https://www.nia.gov.cn/notices/test-notice.html',
    checkedOn: '2026-11-13', reviewDue: '2026-12-15', ...overrides };
}

function auditStore() {
  const log = [];
  return { log, logPolicy(row) {
    log.push({ ...row, id: log.length + 1, ts: TODAY.toISOString() });
    return { persisted: true };
  } };
}

function registryWithRules(transform) {
  const file = require.resolve('../server/policy-registry');
  const data = JSON.parse(fs.readFileSync(require.resolve('../data/policy-registry.json'), 'utf8'));
  transform(data.rules);
  const localRequire = createRequire(file);
  const instance = { exports: {} };
  const code = fs.readFileSync(file, 'utf8');
  new Function('require', 'module', '__dirname', code)((name) => name === 'fs'
    ? { readFileSync: () => JSON.stringify(data) } : localRequire(name), instance, require('node:path').dirname(file));
  return instance.exports;
}

const TODAY = new Date('2026-11-13T12:00:00Z');
const AFTER_TRIAL = new Date('2027-01-02T12:00:00Z'); // 48 国试行已过期，俄罗斯未过期
const AFTER_ALL = new Date('2028-01-02T12:00:00Z');

test.beforeEach(() => registry.reset());

test('国家数据版本、核对日、完整覆盖声明与台账来源快照一致', () => {
  assert.equal(COUNTRIES.version, '2026.11.16');
  assert.equal(COUNTRIES.checkedAt, '2026-11-16');
  assert.equal(REGISTRY_DATA.version, COUNTRIES.version);
  assert.equal(REGISTRY_DATA.checkedAt, COUNTRIES.checkedAt);
  const snapshot = registry.health(new Date('2026-11-16T00:00:00Z'));
  assert.equal(snapshot.version, COUNTRIES.version);
  assert.equal(snapshot.checkedAt, COUNTRIES.checkedAt);
  assert.deepEqual(Object.keys(COUNTRIES.sources).sort(), ['hainan', 'transit', 'unilateral']);
  const unilateralUrl = 'https://dk.china-embassy.gov.cn/lsfw/202609/t20260911_12020891.htm';
  const listUrls = [
    'https://www.nia.gov.cn/n741440/n741542/c1796294/content.html',
    'https://qa.china-embassy.gov.cn/chn/lsfw/lszj/fhqz/202611/t20261102_12051035.htm'
  ];
  const expectedSources = { unilateral: [unilateralUrl], transit: listUrls, hainan: listUrls };
  const mappedRules = { unilateral: ['unilateral-50', 'unilateral-russia', 'unilateral-brunei'],
    transit: ['transit-240'], hainan: ['hainan-30'] };
  for (const [category, urls] of Object.entries(expectedSources)) {
    const sources = COUNTRIES.sources[category];
    assert.deepEqual(sources.map((source) => source.url), urls, category);
    for (const source of sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:');
      assert.notEqual(url.pathname, '/');
      assert.doesNotMatch(url.pathname, /\/(?:index|default|home)(?:\.[^/]*)?$/i);
      assert.ok(source.document.length > 0);
      assert.equal(source.checkedOn, COUNTRIES.checkedAt);
      assert.match(source.publishedOn, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(source.publishedOn <= source.checkedOn);
    }
    for (const ruleId of mappedRules[category]) {
      const rule = snapshot.rules.find((item) => item.id === ruleId);
      assert.equal(rule.checkedOn, COUNTRIES.checkedAt, ruleId);
      assert.deepEqual(rule.sources.map((source) => source.url), urls, ruleId);
      assert.equal(rule.sourceUrl, urls[0], ruleId);
    }
  }
  for (const rule of snapshot.rules) assert.equal(rule.checkedOn, COUNTRIES.checkedAt, rule.id);
  assert.deepEqual({ unilateral: COUNTRIES.coverage.unilateral, transit: COUNTRIES.coverage.transit,
    hainan: COUNTRIES.coverage.hainan, mutual: COUNTRIES.coverage.mutual, globalCoverage: COUNTRIES.coverage.globalCoverage }, {
    unilateral: 50, transit: 57, hainan: 61, mutual: 'partial_unverified', globalCoverage: false
  });
  assert.equal(snapshot.rules.find((rule) => rule.id === 'mutual-agreements').status, 'needs_review');
  assert.equal(registry.guard(new Date('2026-11-16T00:00:00Z'), { ruleIds: ['mutual-agreements'] }).ok, false);
  assert.deepEqual(REGISTRY_DATA.retiredRules.map(({ id, status, replacedBy }) => ({ id, status, replacedBy })), [
    { id: 'taxfree-28', status: 'retired', replacedBy: ['taxfree-port-90', 'taxfree-instant-28'] }
  ]);
});

test('证据主机白名单按入境、互免、退税类别全部允许，未持久化不解除复核', () => {
  const categories = [
    ['unilateral-50', ['www.nia.gov.cn', 'en.nia.gov.cn', 'dk.china-embassy.gov.cn',
      'qa.china-embassy.gov.cn', 'www.gov.cn']],
    ['mutual-agreements', ['cs.mfa.gov.cn', 'www.mfa.gov.cn', 'qa.china-embassy.gov.cn']],
    ['taxfree-port-90', ['www.chinatax.gov.cn', 'www.customs.gov.cn',
      'jiangxi.chinatax.gov.cn', 'shanghai.chinatax.gov.cn']],
    ['taxfree-instant-28', ['www.chinatax.gov.cn', 'www.customs.gov.cn',
      'jiangxi.chinatax.gov.cn', 'shanghai.chinatax.gov.cn']]
  ];
  for (const [ruleId, hosts] of categories) {
    for (const host of hosts) {
      registry.reset();
      registry.markReview({ ruleIds: [ruleId] });
      const evidence = reviewEvidence(ruleId, { sourceUrl: `https://${host}/notices/test-notice.html` });
      const attempts = [];
      const store = { logPolicy(row) { attempts.push(row); return { persisted: false }; } };
      assert.throws(() => registry.acknowledge({ ruleIds: [ruleId], evidence: [evidence], store, now: TODAY }),
        { status: 503 }, `${ruleId}/${host} 应通过格式验证，但不能绕过持久化`);
      assert.equal(attempts.length, 1);
      const recorded = JSON.parse(attempts[0].detail);
      for (const [key, value] of Object.entries(evidence)) assert.equal(recorded[key], value);
      assert.equal(registry.guard(TODAY, { ruleIds: [ruleId] }).ok, false);
      assert.equal(registry.rules(TODAY).find((rule) => rule.id === ruleId).status, 'needs_review');
    }
  }
});

test('各类证据拒绝跨类别及伪造主机、首页、凭据、端口和损坏路径', () => {
  const categories = [
    ['unilateral-50', 'www.nia.gov.cn', ['cs.mfa.gov.cn', 'www.mfa.gov.cn', 'www.chinatax.gov.cn', 'www.customs.gov.cn', 'jiangxi.chinatax.gov.cn', 'shanghai.chinatax.gov.cn']],
    ['mutual-agreements', 'cs.mfa.gov.cn', ['www.nia.gov.cn', 'en.nia.gov.cn', 'dk.china-embassy.gov.cn', 'www.gov.cn', 'www.chinatax.gov.cn', 'www.customs.gov.cn']],
    ['taxfree-port-90', 'jiangxi.chinatax.gov.cn', ['www.nia.gov.cn', 'en.nia.gov.cn', 'dk.china-embassy.gov.cn', 'qa.china-embassy.gov.cn', 'www.gov.cn', 'cs.mfa.gov.cn', 'www.mfa.gov.cn']],
    ['taxfree-instant-28', 'shanghai.chinatax.gov.cn', ['www.nia.gov.cn', 'dk.china-embassy.gov.cn', 'qa.china-embassy.gov.cn', 'cs.mfa.gov.cn']]
  ];
  for (const [ruleId, host, forbiddenHosts] of categories) {
    registry.reset();
    registry.markReview({ ruleIds: [ruleId] });
    const invalidUrls = [
      ...forbiddenHosts.map((otherHost) => `https://${otherHost}/notices/test-notice.html`),
      `http://${host}/notices/test.html`, `https://${host}/`, `https://${host}/notices/`,
      `https://${host}/index.html`, `https://${host}/notices/DEFAULT.htm`,
      `https://${host}/notices/home`, `https://${host}/notices/%69ndex.html`,
      `https://${host}/notices/%`, `https://${host}:8443/notices/test.html`,
      `https://user:password@${host}/notices/test.html`,
      `https://${host}.evil.test/notices/test.html`, `https://sub.${host}/notices/test.html`,
      'https://unverified.china-embassy.gov.cn/notices/test.html',
      'https://unverified.gov.cn/notices/test.html', 'not-a-url'
    ];
    const store = auditStore();
    for (const sourceUrl of invalidUrls) {
      assert.throws(() => registry.acknowledge({ ruleIds: [ruleId],
        evidence: [reviewEvidence(ruleId, { sourceUrl })], store, now: TODAY }), { status: 400 }, `${ruleId}/${sourceUrl}`);
    }
    assert.equal(store.log.length, 0, '拒绝的证据不得写入审计');
    assert.equal(registry.guard(TODAY, { ruleIds: [ruleId] }).ok, false);
  }
});

test('台账在UTC+8截止当日最后毫秒仍未过期，下一毫秒精确硬拦截', () => {
  for (const [date, days, status, blocked] of [
    ['2026-12-30T15:59:59.999Z', 1, 'needs_review', false],
    ['2026-12-30T16:00:00.000Z', 0, 'needs_review', false],
    ['2026-12-31T15:59:59.999Z', 0, 'needs_review', false],
    ['2026-12-31T16:00:00.000Z', -1, 'expired', true]
  ]) {
    const now = new Date(date);
    const rule = registry.rules(now).find((item) => item.id === 'unilateral-50');
    assert.equal(rule.daysToExpiry, days, date);
    assert.equal(rule.status, status, date);
    const gate = registry.guard(now, { ruleIds: ['unilateral-50'] });
    assert.equal(gate.blocked, blocked, date);
    assert.equal(gate.ok, false, '到期前复核已逾期也不能放行');
  }
});

test('当前：互免待逐国核对，其他有效路线可独立放行', () => {
  const h = registry.health(TODAY);
  assert.equal(h.status, 'review');
  assert.equal(h.ok, false);
  assert.equal(h.counts.blocked, 0);
  assert.equal(h.counts.total, 8);
  assert.equal(h.counts.needsReview, 1);
  assert.deepEqual(h.needsReview.map((r) => r.id), ['mutual-agreements']);
  assert.equal(registry.guard(TODAY, { ruleIds: ['unilateral-50'] }).ok, true);
  assert.equal(registry.guard(TODAY, { ruleIds: ['taxfree-port-90', 'taxfree-instant-28'] }).ok, true);
  assert.equal(registry.guard(TODAY, { ruleIds: ['taxfree-28'] }).blocked, true, '退役规则不能再使用');
});

test('无失效日的规则（文莱 / 互免 / 海南）不会被当成过期', () => {
  const byId = Object.fromEntries(registry.rules(AFTER_ALL).map((r) => [r.id, r]));
  assert.equal(byId['unilateral-brunei'].status, 'needs_review', '没到期日，但复核逾期 → 待复核，不是过期');
  assert.equal(byId['unilateral-brunei'].daysToExpiry, null);
  assert.equal(byId['mutual-agreements'].status, 'needs_review');
});

test('试行期一到：相关规则自动过期，判定闸门硬拦截', () => {
  const g = registry.guard(AFTER_TRIAL);
  assert.equal(g.blocked, true);
  assert.ok(g.expired.some((r) => r.id === 'unilateral-50'));
  assert.ok(!g.expired.some((r) => r.id === 'unilateral-russia'), '俄罗斯 2027-12-31 才到期，不该被一起下架');
  assert.equal(registry.health(AFTER_TRIAL).status, 'expired');
});

test('过期日固定按北京时间的自然日算，与服务器所在时区无关', () => {
  assert.equal(registry.daysBetween('2026-11-13', '2026-12-31'), 48);
  // 2026-12-31T12:00Z = 北京 12-31 20:00，仍在有效期内
  assert.equal(registry.today(new Date('2026-12-31T12:00:00Z')), '2026-12-31');
  assert.equal(registry.guard(new Date('2026-12-31T12:00:00Z')).blocked, false, '到期当天仍可用');
  // 2026-12-31T23:00Z 已是北京 01-01 07:00，必须停止
  assert.equal(registry.today(new Date('2026-12-31T23:00:00Z')), '2027-01-01');
  assert.equal(registry.guard(new Date('2026-12-31T23:00:00Z')).blocked, true);
});

test('最早到期日会被算出来，便于提前告警', () => {
  const h = registry.health(TODAY);
  assert.equal(h.soonestExpiry.id, 'unilateral-50');
  assert.equal(h.soonestExpiry.date, '2026-12-31');
  assert.equal(h.soonestExpiry.days, 48);
});

test('官网变化标待复核：ok=false暂停结论，绝不自动改写规则', () => {
  const out = registry.markReview({ ruleIds: ['unilateral-50'], detail: 'page changed' });
  assert.deepEqual(out.marked, ['unilateral-50']);
  const g = registry.guard(TODAY);
  assert.equal(g.blocked, false, '变化不应直接停服');
  assert.equal(g.ok, false);
  assert.ok(g.warnings.some((r) => r.id === 'unilateral-50'));
  assert.equal(registry.health(TODAY).status, 'review');
  // 规则内容没有被抓取结果替换
  assert.equal(registry.rules(TODAY).find((r) => r.id === 'unilateral-50').expiresOn, '2026-12-31');
});

test('人工核对后确认：解除待复核，恢复放行', () => {
  registry.markReview({ ruleIds: ['unilateral-50'], detail: 'changed' });
  assert.equal(registry.guard(TODAY).ok, false);
  const out = registry.acknowledge({ ruleIds: ['unilateral-50'], by: 'tester', detail: '测试证据格式，不代表事实核验',
    evidence: [reviewEvidence('unilateral-50')], store: auditStore(), now: TODAY });
  assert.deepEqual(out.acknowledged, ['unilateral-50']);
  assert.equal(registry.guard(TODAY, { ruleIds: ['unilateral-50'] }).ok, true);
  assert.equal(registry.guard(TODAY).ok, false, '互免尚未逐国核实，不能假称全部可用');
});

test('人工复核及审计重放仅返回实际证据来源，新链接不沿用旧标题', () => {
  for (const ruleId of ['transit-240', 'unilateral-russia']) {
    const original = REGISTRY_DATA.rules.find((rule) => rule.id === ruleId);
    const knownSources = original.sources || [{ url: original.sourceUrl, document: original.document }];
    for (const source of [...knownSources, { url: reviewEvidence(ruleId).sourceUrl, document: null }]) {
      registry.reset();
      const store = auditStore();
      registry.markReview({ ruleIds: [ruleId] });
      registry.acknowledge({ ruleIds: [ruleId], evidence: [reviewEvidence(ruleId, { sourceUrl: source.url })],
        store, now: TODAY });
      const check = () => {
        const rule = registry.rules(TODAY).find((item) => item.id === ruleId);
        assert.equal(rule.sourceUrl, source.url);
        assert.equal(rule.document, source.document);
        assert.deepEqual(rule.sources, [{ url: source.url, document: source.document }]);
        assert.equal(registry.guard(TODAY, { ruleIds: [ruleId] }).ok, true);
        assert.equal(registry.rules(TODAY).find((item) => item.id === 'mutual-agreements').status, 'needs_review');
      };
      check();
      registry.reset();
      assert.equal(registry.replayAudit(store.log), 0);
      check();
    }
  }
});

test('缺失来源列表安全回退，有显式空列表时不伪造来源', () => {
  for (const sources of [undefined, null, {}, []]) {
    const isolated = registryWithRules((rules) => {
      rules[0].sources = sources;
      delete rules[1].sources;
      delete rules[1].sourceUrl;
    });
    const rules = isolated.rules(TODAY);
    assert.deepEqual(rules[0].sources, Array.isArray(sources) ? []
      : [{ url: rules[0].sourceUrl, document: rules[0].document }]);
    assert.deepEqual(rules[1].sources, []);
  }
});

test('台账重放：重启后「待复核」不丢失', () => {
  const log = [
    { ruleId: 'unilateral-50', event: 'source_changed', ts: '2026-11-01' },
    { ruleId: 'unilateral-50', event: 'reviewed', ts: '2026-11-02' },
    { ruleId: 'transit-240', event: 'source_changed', ts: '2026-11-03' }
  ];
  const n = registry.replayAudit(log);
  assert.equal(n, 2, '旧的无证据 reviewed 也必须保持待复核');
  const g = registry.guard(TODAY);
  assert.ok(g.warnings.some((r) => r.id === 'transit-240'));
  assert.ok(g.warnings.some((r) => r.id === 'unilateral-50'), '无证据的旧确认不能假恢复');
});

test('运维令牌未配置时，确认接口必须禁用', () => {
  assert.equal(registry.adminEnabled(), false);
  assert.equal(registry.isAdmin('anything'), false);
});

test('期限和下架状态绝对优先于复核标记', () => {
  registry.markReview({ ruleIds: ['unilateral-50'] });
  assert.equal(registry.rules(AFTER_TRIAL).find((r) => r.id === 'unilateral-50').status, 'expired');
  for (const [state, change] of [
    ['pending', (rule) => { rule.effectiveFrom = '2027-01-01'; }],
    ['retired', (rule) => { rule.status = 'retired'; }],
    ['expired', (rule) => { rule.status = 'expired'; }]
  ]) {
    const isolated = registryWithRules((rules) => change(rules[0]));
    isolated.markReview({ ruleIds: ['unilateral-50'] });
    assert.equal(isolated.rules(TODAY)[0].status, state);
    assert.equal(isolated.guard(TODAY, { ruleIds: ['unilateral-50'] }).blocked, true);
  }
});

test('审计重放按时间及同时间的数字 id 排序，与正倒序无关', () => {
  const reviewed = { ruleId: 'unilateral-50', event: 'reviewed', ts: TODAY.toISOString(),
    id: 10, detail: JSON.stringify(reviewEvidence('unilateral-50')) };
  const log = [
    { ...reviewed, event: 'source_changed', id: 9 },
    reviewed,
    { ruleId: 'transit-240', event: 'source_changed', ts: '2026-11-14T12:00:00Z', id: 1 },
    { ruleId: 'transit-240', event: 'reviewed', ts: '2026-11-12T12:00:00Z', id: 99 }
  ];
  for (const entries of [log, [...log].reverse()]) {
    registry.reset();
    assert.equal(registry.replayAudit(entries), 1);
    assert.equal(registry.guard(TODAY, { ruleIds: ['unilateral-50'] }).ok, true);
    assert.equal(registry.guard(TODAY, { ruleIds: ['transit-240'] }).ok, false);
  }
});

test('缺少或损坏证据的 reviewed 重放绝不能恢复正常', () => {
  for (const detail of ['operator: checked', '{}', JSON.stringify(reviewEvidence('unilateral-50', {
    sourceUrl: 'https://www.nia.gov.cn/'
  })), JSON.stringify(reviewEvidence('unilateral-50', { reviewDue: '2028-01-01' }))]) {
    registry.reset();
    assert.equal(registry.replayAudit([{ ruleId: 'unilateral-50', event: 'reviewed',
      id: 1, ts: TODAY.toISOString(), detail }]), 1);
    assert.equal(registry.guard(TODAY, { ruleIds: ['unilateral-50'] }).ok, false);
  }
});

test('有效证据及 reviewDue 持久化后重启恢复，复核到期再次提示且不延长失效日', () => {
  const now = new Date('2026-12-05T12:00:00Z');
  const store = auditStore();
  store.logPolicy = (row) => {
    store.log.push({ ...row, id: 1, ts: now.toISOString() });
    return { persisted: true };
  };
  const evidence = reviewEvidence('unilateral-50', { checkedOn: '2026-12-05' });
  assert.equal(registry.guard(now, { ruleIds: ['unilateral-50'] }).ok, false);
  registry.acknowledge({ ruleIds: ['unilateral-50'], evidence: [evidence], now, store });
  assert.equal(JSON.parse(store.log[0].detail).reviewDue, '2026-12-15');
  assert.equal(registry.guard(now, { ruleIds: ['unilateral-50'] }).ok, true);
  registry.reset();
  assert.equal(registry.replayAudit(store.log), 0);
  assert.equal(registry.guard(now, { ruleIds: ['unilateral-50'] }).ok, true);
  assert.equal(registry.rules(now)[0].reviewDue, '2026-12-15');
  assert.equal(registry.rules(now)[0].expiresOn, '2026-12-31');
  assert.equal(registry.guard(new Date('2026-12-16T12:00:00Z'), { ruleIds: ['unilateral-50'] }).ok, false);
  assert.equal(registry.guard(AFTER_TRIAL, { ruleIds: ['unilateral-50'] }).blocked, true);
});

test('逐规则证据必须完整；错误链接、日期与延长失效日一律拒绝', () => {
  registry.markReview({ ruleIds: ['unilateral-50'] });
  const store = auditStore();
  const invalid = [
    { sourceUrl: 'http://www.nia.gov.cn/notices/test.html' },
    { sourceUrl: 'https://www.nia.gov.cn/' },
    { sourceUrl: 'https://www.nia.gov.cn/index.html' },
    { sourceUrl: 'https://www.nia.gov.cn.evil.test/notices/test.html' },
    { sourceUrl: 'https://www.chinatax.gov.cn/notices/test.html' },
    { sourceUrl: 'https://user@www.nia.gov.cn/notices/test.html' },
    { checkedOn: '2026-11-14' },
    { checkedOn: '2026-02-30' },
    { checkedOn: '2026-11-13T00:00:00Z' },
    { reviewDue: '2026-11-13' },
    { reviewDue: '2027-01-01' }
  ];
  for (const patch of invalid) {
    assert.throws(() => registry.acknowledge({ ruleIds: ['unilateral-50'],
      evidence: [reviewEvidence('unilateral-50', patch)], store, now: TODAY }), { status: 400 });
  }
  assert.throws(() => registry.acknowledge({ ruleIds: ['unilateral-50', 'transit-240'],
    evidence: [reviewEvidence('unilateral-50')], store, now: TODAY }), { status: 400 });
  assert.throws(() => registry.acknowledge({ ruleIds: ['missing'], evidence: [], store, now: TODAY }), { status: 400 });
  assert.throws(() => registry.acknowledge({ store, now: TODAY }), { status: 400 });
  assert.throws(() => registry.acknowledge({ ruleIds: ['transit-240'],
    evidence: [reviewEvidence('transit-240', { reviewDue: '2027-11-15' })], store, now: TODAY }), { status: 400 });
  assert.equal(store.log.length, 0, '整批证据验证完成前不得写入');
  assert.equal(registry.guard(TODAY).ok, false);
});

test('审计缺失、失败、异常以及未明确 persisted 均不能解除复核', () => {
  for (const store of [undefined, { logPolicy: () => ({ persisted: false }) },
    { logPolicy: () => ({}) }, { logPolicy: () => { throw new Error('disk full'); } }]) {
    registry.markReview({ ruleIds: ['unilateral-50'] });
    assert.throws(() => registry.acknowledge({ ruleIds: ['unilateral-50'],
      evidence: [reviewEvidence('unilateral-50')], store, now: TODAY }), { status: 503 });
    assert.equal(registry.guard(TODAY, { ruleIds: ['unilateral-50'] }).ok, false);
  }
});

test('路线规则映射与引擎一致，退税和其他路线不阻断无关结论', () => {
  for (const [body, ids] of [
    [{ countryCode: 'DE' }, ['unilateral-50']],
    [{ countryCode: 'RU' }, ['unilateral-russia']],
    [{ countryCode: 'BN' }, ['unilateral-brunei']],
    [{ countryCode: 'DE', stayDays: 31 }, ['unilateral-50']],
    [{ countryCode: 'SG' }, ['mutual-agreements']],
    [{ countryCode: 'SG', stayDays: 31 }, ['mutual-agreements']],
    [{ countryCode: 'US', purpose: 'tr', next: 'third' }, ['transit-240']],
    [{ countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 11 }, ['transit-240']],
    [{ countryCode: 'US', purpose: 'tr', next: 'home' }, ['transit-240']],
    [{ countryCode: 'US', port: 'HAK' }, ['hainan-30']],
    [{ countryCode: 'LT', port: 'HAK' }, ['hainan-30']],
    [{ countryCode: 'LI' }, ['unilateral-50']],
    [{ countryCode: 'KG', purpose: 'tr', next: 'third' }, ['transit-240']],
    [{ countryCode: 'VN', purpose: 'tr', next: 'third' }, ['transit-240']],
    [{ countryCode: 'KG', port: 'HAK' }, ['hainan-30']],
    [{ countryCode: 'VN', port: 'HAK' }, ['hainan-30']],
    [{ countryCode: 'DE', purpose: 'work' }, []],
    [{ countryCode: 'DE', passportType: 'other' }, []],
    [{ countryCode: 'US' }, []],
    [{ countryCode: 'OK' }, []],
    [{ countryCode: 'IN' }, []]
  ]) {
    assert.deepEqual(registry.ruleIdsForVerdict(evaluate(body), body), ids);
  }
  registry.markReview({ ruleIds: ['taxfree-port-90', 'unilateral-50'] });
  for (const [countryCode, expected] of [['DE', 'unilateral-50'], ['RU', 'unilateral-russia']]) {
    const expired = evaluate({ countryCode }, { now: AFTER_ALL });
    assert.equal(expired.route, 'policy_expired');
    assert.deepEqual(registry.ruleIdsForVerdict(expired), [expected]);
  }
  assert.equal(registry.guard(TODAY, { ruleIds: ['unilateral-russia'] }).ok, true);
  assert.equal(registry.guard(AFTER_TRIAL, { ruleIds: ['unilateral-russia'] }).blocked, false);
  assert.equal(registry.guard(AFTER_TRIAL, { ruleIds: ['transit-240'] }).blocked, false);
  assert.equal(registry.guard(TODAY, { ruleIds: [] }).ok, true);
  assert.equal(registry.guard(TODAY, { ruleIds: ['missing-required-rule'] }).blocked, true);
  assert.equal(registry.guard(TODAY, { ruleIds: null }).blocked, true);
  assert.equal(registry.guard(TODAY, { ruleIds: registry.ruleIdsForVerdict({ route: 'unknown' }) }).blocked, true);
});

test('已下架审计不会被变化标记或人工复核解除，超长审计不得截断后放行', () => {
  registry.replayAudit([{ ruleId: 'transit-240', event: 'retired', id: 1, ts: TODAY.toISOString() }]);
  registry.markReview({ ruleIds: ['transit-240'] });
  assert.equal(registry.rules(TODAY).find((r) => r.id === 'transit-240').status, 'retired');
  assert.throws(() => registry.acknowledge({ ruleIds: ['transit-240'],
    evidence: [reviewEvidence('transit-240')], store: auditStore(), now: TODAY }), { status: 409 });
  assert.throws(() => registry.acknowledge({ ruleIds: ['unilateral-50'],
    evidence: [reviewEvidence('unilateral-50')], detail: 'x'.repeat(500), store: auditStore(), now: TODAY }), { status: 400 });
});

test('配置令牌使用安全比较，非字符串与错误长度均返回 false', () => {
  const previous = process.env.POLICY_ADMIN_TOKEN;
  process.env.POLICY_ADMIN_TOKEN = 'test-admin-secret';
  let isolated;
  try { isolated = registryWithRules(() => {}); }
  finally {
    if (previous === undefined) delete process.env.POLICY_ADMIN_TOKEN;
    else process.env.POLICY_ADMIN_TOKEN = previous;
  }
  assert.equal(isolated.adminEnabled(), true);
  assert.equal(isolated.isAdmin('test-admin-secret'), true);
  for (const token of ['', 'wrong', 'test-admin-secret-long', null, {}, ['test-admin-secret']]) {
    assert.equal(isolated.isAdmin(token), false);
  }
});

test('来源模型写清楚：不是官方结构化 API', () => {
  assert.match(registry.health(TODAY).sourceModel, /无官方结构化 API/);
});
