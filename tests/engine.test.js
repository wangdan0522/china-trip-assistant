'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const engine = require('../server/policy-engine');
const i18n = require('../server/i18n');
const content = require('../server/content');

const EXPECTED_COUNTRIES = {
  f: 'AD AT BE BG HR CY DK EE FI FR DE GR HU IS IE IT LV LI LU MT MC ME NL MK NO PL PT RO RU SK SI ES SE CH GB AU NZ BH BN JP KW OM KR SA AR BR CA CL PE UY'.split(' '),
  t: 'AT BE CZ DK EE FI FR DE GR HU IS IT LV LT LU MT NL PL PT SK SI ES SE CH MC RU GB IE CY BG RO UA RS HR BA ME MK AL BY NO US CA BR MX AR CL AU NZ KR JP SG BN AE QA ID KG VN'.split(' '),
  h: 'RU GB FR DE NO UA IT AT FI NL DK CH SE ES BE CZ EE GR HU IS LV LT LU MT PL PT SK SI IE CY BG RO RS HR BA ME MK AL US CA BR MX AR CL AU NZ KR JP SG MY TH KZ PH ID BN AE QA MC BY KG VN'.split(' '),
  m: 'AE BY GE MY RS SG TH'.split(' ')
};

const NOW = new Date('2026-11-13T10:00:00Z');

function run(input, now = NOW) {
  return engine.evaluate(input, { now });
}

/* ---------------- 结构性约束 ---------------- */

function assertBlocked(result, route) {
  assert.equal(result.code, 'X');
  assert.equal(result.route, route);
  assert.equal(result.titleKey, route === 'policy_expired' ? 'v.blocked.title' : 'v.title.not_covered');
  assert.equal(result.whyKey, 'v.blocked.why');
  assert.ok(Object.hasOwn(result.whyParams, 'date'));
  assert.deepEqual(result.points, [{ key: 'v.blocked.point', tone: 'warn' }]);
}

test('国家数据逐项精确覆盖完整 F50 / T57 / H61 与7条未核验互免线索', () => {
  const { items, order, coverage } = engine.COUNTRIES;
  for (const [flag, expected] of Object.entries(EXPECTED_COUNTRIES)) {
    assert.equal(new Set(expected).size, expected.length, `${flag} 预期清单不得重复`);
    assert.deepEqual(Object.keys(items).filter((code) => items[code][flag] === 1).sort(),
      [...expected].sort(), `${flag} 必须逐国相同，不能只比较数量`);
  }
  const expectedCodes = [...new Set([...Object.values(EXPECTED_COUNTRIES).flat(), 'IN', 'OK'])].sort();
  assert.equal(expectedCodes.length, 72);
  assert.deepEqual(Object.keys(items).sort(), expectedCodes);
  assert.equal(new Set(order).size, order.length);
  assert.deepEqual([...order].sort(), expectedCodes);
  assert.deepEqual({ unilateral: coverage.unilateral, transit: coverage.transit, hainan: coverage.hainan,
    mutual: coverage.mutual, globalCoverage: coverage.globalCoverage }, {
    unilateral: 50, transit: 57, hainan: 61, mutual: 'partial_unverified', globalCoverage: false
  });
  for (const [code, country] of Object.entries(items)) {
    for (const flag of ['f', 't', 'h']) assert.ok([0, 1].includes(country[flag]), `${code}.${flag}`);
    assert.ok(country.m === undefined || country.m === 1, `${code}.m`);
  }
});

test('完整名单的可用路线保持优先级，互免线索始终转复核', () => {
  for (const countryCode of EXPECTED_COUNTRIES.f) {
    const result = run({ countryCode });
    assert.equal(result.code, 'A', countryCode);
    assert.equal(result.route, 'unilateral', countryCode);
    assert.equal(result.policy.version, engine.COUNTRIES.version, countryCode);
    assert.equal(result.policy.checkedAt, engine.COUNTRIES.checkedAt, countryCode);
  }
  for (const countryCode of EXPECTED_COUNTRIES.t) {
    const result = run({ countryCode, purpose: 'tr', next: 'third', stayDays: 10 });
    const expectedRoute = EXPECTED_COUNTRIES.f.includes(countryCode) ? 'unilateral'
      : EXPECTED_COUNTRIES.m.includes(countryCode) ? 'mutual_review' : 'transit240';
    assert.equal(result.route, expectedRoute, countryCode);
    assert.equal(result.code, expectedRoute === 'mutual_review' ? 'X' : 'A', countryCode);
  }
  for (const countryCode of EXPECTED_COUNTRIES.h) {
    for (const port of ['HAK', 'SYX']) {
      const result = run({ countryCode, port, stayDays: 30 });
      const expectedRoute = EXPECTED_COUNTRIES.f.includes(countryCode) ? 'unilateral'
        : EXPECTED_COUNTRIES.m.includes(countryCode) ? 'mutual_review' : 'hainan';
      assert.equal(result.route, expectedRoute, `${countryCode}/${port}`);
      assert.equal(result.code, expectedRoute === 'mutual_review' ? 'X' : 'A', `${countryCode}/${port}`);
    }
  }
  for (const countryCode of EXPECTED_COUNTRIES.m) {
    for (const stayDays of [1, 30, 31, 180]) {
      assertBlocked(run({ countryCode, stayDays }), 'mutual_review');
    }
  }
});

test('立陶宛海南、列支敦士登单方面及吉尔吉斯斯坦/越南双清单均可到达正确分支', () => {
  assert.equal(run({ countryCode: 'LT', port: 'HAK', stayDays: 30 }).route, 'hainan');
  assert.equal(run({ countryCode: 'LI', stayDays: 30 }).route, 'unilateral');
  assert.equal(run({ countryCode: 'LI', purpose: 'tr', next: 'third' }).route, 'unilateral');
  for (const countryCode of ['KG', 'VN']) {
    assert.equal(run({ countryCode, purpose: 'tr', next: 'third', stayDays: 10 }).route, 'transit240');
    assert.equal(run({ countryCode, purpose: 'tr', next: 'third', stayDays: 11 }).route, 'transit240_overstay');
    assert.equal(run({ countryCode, port: 'HAK', stayDays: 30 }).route, 'hainan');
    assertBlocked(run({ countryCode, port: 'HAK', stayDays: 31 }), 'coverage_unknown');
    assertBlocked(run({ countryCode }), 'coverage_unknown');
  }
});

test('OK只是无通行标记的非国家占位，不进入任何确定路线或ICU地区名', () => {
  const country = engine.COUNTRIES.items.OK;
  assert.equal(country.placeholder, true);
  for (const flag of ['f', 't', 'h', 'm']) assert.ok(!country[flag], `OK.${flag}`);
  for (const purpose of engine.PURPOSES) {
    for (const port of Object.keys(engine.PORTS)) {
      for (const next of ['home', 'third']) assertBlocked(run({ countryCode: 'OK', purpose, port, next }), 'coverage_unknown');
    }
  }
  const labels = { en: 'Other / not listed', zh: '其他 / 未列出', ja: 'その他 / 一覧にない',
    ko: '기타 / 목록에 없음', es: 'Otro / no figura en la lista', ru: 'Другое / нет в списке' };
  for (const lang of i18n.CODES) {
    assert.equal(i18n.countryName('OK', lang), labels[lang]);
    assert.notEqual(i18n.countryName('OK', lang), new Intl.DisplayNames([lang], { type: 'region' }).of('OK'));
  }
});

test('概览倒计时按UTC+8在截止次日才过期，与各语种的实际截止日一致', () => {
  for (const lang of i18n.CODES) {
    const expires = i18n.pack(lang).policy.expiry.unilateralTrial;
    const midnightUTC = Date.parse(`${expires}T00:00:00Z`) - 8 * 3600000;
    for (const [offset, daysUntilExpiry, level] of [
      [-1, 1, 'critical'], [0, 0, 'critical'], [86400000 - 1, 0, 'critical'], [86400000, -1, 'expired']
    ]) {
      assert.deepEqual(content.policyOverview(lang, new Date(midnightUTC + offset)).countdown,
        { expires, daysUntilExpiry, level }, `${lang}/${offset}`);
    }
  }
});

test('概览截止边界不依赖宿主时区或尚待同步的语种机器字段', () => {
  const script = `
    const content = require(${JSON.stringify(require.resolve('../server/content'))});
    const i18n = require(${JSON.stringify(require.resolve('../server/i18n'))});
    const expires = i18n.pack('en').policy.expiry.unilateralTrial;
    const start = Date.parse(expires + 'T00:00:00Z') - 8 * 3600000;
    process.stdout.write(JSON.stringify([0, 86400000 - 1, 86400000].map((offset) =>
      content.policyOverview('en', new Date(start + offset)).countdown
    )));
  `;
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const results = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ }, encoding: 'utf8'
    }));
    assert.deepEqual(results.map(({ daysUntilExpiry, level }) => ({ daysUntilExpiry, level })), [
      { daysUntilExpiry: 0, level: 'critical' }, { daysUntilExpiry: 0, level: 'critical' },
      { daysUntilExpiry: -1, level: 'expired' }
    ], TZ);
  }
});

test('引擎不产出自然语言：已覆盖和待复核分支均只给消息键', () => {
  const scenarios = [
    [{ countryCode: 'DE' }, NOW],
    [{ countryCode: 'OK' }, NOW],
    [{ countryCode: 'GE' }, NOW],
    [{ countryCode: 'DE' }, new Date('2027-01-05T00:00:00Z')]
  ];
  for (const [input, now] of scenarios) {
    const r = run(input, now);
    assert.equal(r.title, undefined);
    assert.equal(r.why, undefined);
    assert.match(r.titleKey, /^v\.(title\.[a-z_]+|blocked\.title)$/);
    assert.match(r.whyKey, /^v\.(why\.[a-z_]+|blocked\.why)$/);
    for (const p of r.points) {
      assert.match(p.key, /^v\.(p\.[a-z_.]+|blocked\.point)$/);
      assert.equal(p.text, undefined);
    }
  }
});

test('引擎产出的每个消息键在英文包里都存在', () => {
  const scenarios = [
    { countryCode: 'DE', purpose: 'tour', stayDays: 10 },
    { countryCode: 'DE', purpose: 'tour', stayDays: 45 },
    { countryCode: 'DE', purpose: 'work' },
    { countryCode: 'DE', passportType: 'other' },
    { countryCode: 'US', purpose: 'tour' },
    { countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 5 },
    { countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 11 },
    { countryCode: 'US', purpose: 'tr', next: 'home' },
    { countryCode: 'OK' },
    { countryCode: 'GE', purpose: 'tour', stayDays: 10 },
    { countryCode: 'GE', purpose: 'tour', stayDays: 40 },
    { countryCode: 'PH', port: 'HAK', purpose: 'tour', stayDays: 10 },
    { countryCode: 'BN', purpose: 'tour', stayDays: 10 }
  ];
  const en = i18n.pack('en').verdict;
  const results = [
    ...scenarios.map((s) => run(s)),
    run({ countryCode: 'DE' }, new Date('2027-01-05T00:00:00Z'))
  ];
  for (const r of results) {
    const messages = [
      { key: r.titleKey, params: r.whyParams },
      { key: r.whyKey, params: r.whyParams },
      ...r.points
    ];
    for (const { key, params } of messages) {
      assert.ok(Object.hasOwn(en, key), `missing ${key}`);
      assert.equal(typeof en[key], 'string');
      for (const [, name] of en[key].matchAll(/\{(\w+)\}/g)) {
        assert.ok(params && Object.hasOwn(params, name), `missing ${key} parameter ${name}`);
        assert.notEqual(params[name], undefined);
        assert.notEqual(params[name], null);
      }
    }
    for (const lang of i18n.CODES) {
      const rendered = i18n.renderVerdict(r, lang);
      for (const text of [rendered.title, rendered.why, ...rendered.points.map((p) => p.text)]) {
        assert.doesNotMatch(text, /\{\w+\}|⟦/);
      }
    }
  }
});

/* ---------------- 分支正确性 ---------------- */

test('单方面免签：德国 10 天 → A / unilateral', () => {
  const r = run({ countryCode: 'DE', purpose: 'tour', stayDays: 10 });
  assert.equal(r.code, 'A');
  assert.equal(r.route, 'unilateral');
  assert.equal(r.policy.expires, '2026-12-31');
  assert.equal(r.policy.daysUntilExpiry, 48); // 自然日差，不是 49
});

test('单方面免签：德国 45 天 → B / 超限，且参数带天数', () => {
  const r = run({ countryCode: 'DE', purpose: 'tour', stayDays: 45 });
  assert.equal(r.code, 'B');
  assert.equal(r.route, 'unilateral_overstay');
  assert.equal(r.whyParams.days, 45);
});

test('文莱：无固定截止日期，不能当日期算', () => {
  const r = run({ countryCode: 'BN', purpose: 'tour', stayDays: 10 });
  assert.equal(r.code, 'A');
  assert.equal(r.policy.expires, null);
  assert.equal(r.policy.daysUntilExpiry, null);
  assert.ok(r.points.some((p) => p.key === 'v.p.expiry.none'));
});

test('俄罗斯：到期日跟随机型而不是通用试行日', () => {
  const r = run({ countryCode: 'RU', purpose: 'tour', stayDays: 10 });
  assert.equal(r.policy.expires, '2027-12-31');
});

test('没有覆盖普通旅游路线时不能推断一定需要签证', () => {
  for (const countryCode of ['US', 'IN', 'OK']) {
    assertBlocked(run({ countryCode, purpose: 'tour', stayDays: 10 }), 'coverage_unknown');
  }
});

test('美国走 240 小时过境：5 天 + 去第三国 → A', () => {
  const r = run({ countryCode: 'US', purpose: 'tr', next: 'third', stayDays: 5 });
  assert.equal(r.code, 'A');
  assert.equal(r.route, 'transit240');
});

test('美国原路返回：不构成过境 → B / transit_not_met', () => {
  const r = run({ countryCode: 'US', purpose: 'tr', next: 'home' });
  assert.equal(r.code, 'B');
  assert.equal(r.route, 'transit_not_met');
});

test('互免标记缺少已核验期限时，任何天数都需要复核', () => {
  for (const stayDays of [1, 20, 30, 40, 180]) {
    const r = run({ countryCode: 'GE', purpose: 'tour', stayDays });
    assertBlocked(r, 'mutual_review');
    assert.deepEqual(r.meta.mutual, {
      reviewRequired: true,
      maxDays: null,
      sourceUrl: null,
      cumulative: null
    });
  }
});

test('海南免签：菲律宾 + 海口 = A / 仅限海南（有 warn 项）', () => {
  const r = run({ countryCode: 'PH', port: 'HAK', purpose: 'tour', stayDays: 10 });
  assert.equal(r.code, 'A');
  assert.equal(r.route, 'hainan');
  assert.ok(r.points.some((p) => p.tone === 'warn'));
});

test('海南路线不支持当前口岸或停留天数时返回覆盖未知', () => {
  assertBlocked(run({ countryCode: 'PH', port: 'PVG', purpose: 'tour', stayDays: 10 }), 'coverage_unknown');
  assertBlocked(run({ countryCode: 'PH', port: 'HAK', purpose: 'tour', stayDays: 31 }), 'coverage_unknown');
});

test('互免全国路线保留优先级，不能退化为海南或默认允许入境', () => {
  for (const input of [
    { countryCode: 'TH', port: 'HAK', purpose: 'tour', stayDays: 10 },
    { countryCode: 'SG', port: 'HAK', purpose: 'tr', next: 'third', stayDays: 5 }
  ]) {
    const r = run(input);
    assertBlocked(r, 'mutual_review');
    assert.equal(r.meta.mutual.maxDays, null);
  }
});

test('工作/学习不在任何免签范围', () => {
  const r = run({ countryCode: 'DE', purpose: 'work', stayDays: 5 });
  assert.equal(r.code, 'C');
  assert.equal(r.whyKey, 'v.why.work');
});

test('非普通护照只表达未覆盖，不推断所有特殊护照均需签证', () => {
  for (const countryCode of ['DE', 'GE', 'OK']) {
    for (const purpose of ['tour', 'work']) {
      assertBlocked(run({ countryCode, passportType: 'other', purpose }), 'coverage_unknown');
    }
  }
});

test('同时符合免签与过境：提示两者比较过，免签更优', () => {
  const r = run({ countryCode: 'DE', purpose: 'tr', next: 'third', stayDays: 5 });
  assert.equal(r.route, 'unilateral');
  assert.ok(r.points.some((p) => p.key === 'v.p.uni.vs_transit'));
});

test('政策到期倒计时随注入时间变化（不是写死的）', () => {
  const a = run({ countryCode: 'DE' }, new Date('2026-11-13T00:00:00Z'));
  const b = run({ countryCode: 'DE' }, new Date('2026-12-01T00:00:00Z'));
  assert.equal(a.policy.daysUntilExpiry, 48);
  assert.equal(b.policy.daysUntilExpiry, 30);
});

test('到期后停止单方面免签判断，包括超限和过境输入', () => {
  const now = new Date('2027-01-05T00:00:00Z');
  for (const input of [
    { countryCode: 'DE' },
    { countryCode: 'DE', stayDays: 45 },
    { countryCode: 'DE', purpose: 'tr', next: 'third', stayDays: 5 }
  ]) {
    const r = run(input, now);
    assertBlocked(r, 'policy_expired');
    assert.equal(r.policy.expires, '2026-12-31');
    assert.equal(r.policy.daysUntilExpiry, -5);
    assert.equal(r.whyParams.date, r.policy.expires);
  }
});

test('政策到期不能阻断普通护照的工作签证提示', () => {
  const r = run({ countryCode: 'DE', purpose: 'work' }, new Date('2027-01-05T00:00:00Z'));
  assert.equal(r.code, 'C');
  assert.equal(r.route, 'visa_required');
  assert.equal(r.whyKey, 'v.why.work');
});

test('北京时间午夜精确切换有效期，截止日当天仍有效', () => {
  const before = run({ countryCode: 'DE' }, new Date('2026-12-30T15:59:59.999Z'));
  const onExpiry = run({ countryCode: 'DE' }, new Date('2026-12-30T16:00:00Z'));
  const lastMillisecond = run({ countryCode: 'DE' }, new Date('2026-12-31T15:59:59.999Z'));
  const after = run({ countryCode: 'DE' }, new Date('2026-12-31T16:00:00Z'));
  assert.equal(before.policy.daysUntilExpiry, 1);
  for (const r of [onExpiry, lastMillisecond]) {
    assert.equal(r.code, 'A');
    assert.equal(r.policy.daysUntilExpiry, 0);
  }
  assertBlocked(after, 'policy_expired');
  assert.equal(after.policy.daysUntilExpiry, -1);
});

test('日期判断不依赖宿主时区', () => {
  const script = `
    const { evaluate } = require(${JSON.stringify(require.resolve('../server/policy-engine'))});
    const dates = ['2026-11-13T15:59:59Z', '2026-11-13T16:00:00Z', '2026-12-31T16:00:00Z'];
    process.stdout.write(JSON.stringify(dates.map((date) => {
      const r = evaluate({ countryCode: 'DE' }, { now: new Date(date) });
      return { route: r.route, days: r.policy.daysUntilExpiry };
    })));
  `;
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const results = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ }, encoding: 'utf8'
    }));
    assert.deepEqual(results, [
      { route: 'unilateral', days: 48 },
      { route: 'unilateral', days: 47 },
      { route: 'policy_expired', days: -1 }
    ], TZ);
  }
});

/* ---------------- 输入校验 ---------------- */

test('非法输入一律拒绝，不做猜测式纠错', () => {
  assert.throws(() => run({ countryCode: 'ZZ' }), (e) => e.name === 'ValidationError' && e.field === 'countryCode');
  assert.throws(() => run({ countryCode: 'DE', stayDays: 0 }), (e) => e.field === 'stayDays');
  assert.throws(() => run({ countryCode: 'DE', stayDays: 181 }), (e) => e.field === 'stayDays');
  assert.throws(() => run({ countryCode: 'DE', stayDays: 3.5 }), (e) => e.field === 'stayDays');
  assert.throws(() => run({ countryCode: 'DE', passportType: 'diplomatic' }), (e) => e.field === 'passportType');
  assert.throws(() => run({ countryCode: 'DE', port: 'XXX' }), (e) => e.field === 'port');
  assert.throws(() => run({ countryCode: 'DE', next: 'moon' }), (e) => e.field === 'next');
  assert.throws(() => run(null), (e) => e.field === 'body');
});

test('请求体必须是非数组对象，数组即使携带合法字段也拒绝', () => {
  const array = [];
  array.countryCode = 'DE';
  for (const raw of [null, undefined, false, 1, 'DE', [], ['DE'], array]) {
    assert.throws(() => run(raw), (e) => e instanceof engine.ValidationError && e.field === 'body');
  }
});

test('停留天数仅接受整数 number，不执行隐式类型转换', () => {
  for (const stayDays of [true, false, '', '10', ' ', null, [], [10], {}, NaN, Infinity, -Infinity]) {
    assert.throws(() => run({ countryCode: 'DE', stayDays }),
      (e) => e instanceof engine.ValidationError && e.field === 'stayDays');
  }
  assert.equal(run({ countryCode: 'DE', stayDays: 1 }).meta.inputs.stayDays, 1);
  assert.equal(run({ countryCode: 'DE', stayDays: 180 }).meta.inputs.stayDays, 180);
});

test('国家代码不执行隐式转换，原型继承键不能当作国家', () => {
  for (const countryCode of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ['DE'], true, 1, null,
    { toString() { throw new Error('不应触发类型转换'); } }]) {
    assert.throws(() => run({ countryCode }),
      (e) => e instanceof engine.ValidationError && e.field === 'countryCode');
  }
  const originalPrototype = Object.getPrototypeOf(engine.COUNTRIES.items);
  Object.setPrototypeOf(engine.COUNTRIES.items, { ENGINE_TEST_COUNTRY: { f: 1 } });
  try {
    assert.throws(() => run({ countryCode: 'ENGINE_TEST_COUNTRY' }),
      (e) => e instanceof engine.ValidationError && e.field === 'countryCode');
  } finally {
    Object.setPrototypeOf(engine.COUNTRIES.items, originalPrototype);
  }
  assert.equal(run({ countryCode: 'de' }).meta.inputs.countryCode, 'DE');
});

test('可选枚举只在 undefined 时使用默认值，拒绝伪空值和原型键', () => {
  for (const field of ['passportType', 'purpose', 'port', 'next']) {
    for (const value of [null, false, 0, '', [], '__proto__', 'constructor']) {
      assert.throws(() => run({ countryCode: 'DE', [field]: value }),
        (e) => e instanceof engine.ValidationError && e.field === field);
    }
  }
});

test('占位国家即使带有路线标记，也不能获得确定结论', () => {
  const country = engine.COUNTRIES.items.DE;
  const descriptor = Object.getOwnPropertyDescriptor(country, 'placeholder');
  country.placeholder = true;
  try {
    assertBlocked(run({ countryCode: 'DE' }), 'coverage_unknown');
    assertBlocked(run({ countryCode: 'DE', purpose: 'work' }), 'coverage_unknown');
    assertBlocked(run({ countryCode: 'OK', purpose: 'work' }), 'coverage_unknown');
  } finally {
    if (descriptor) Object.defineProperty(country, 'placeholder', descriptor);
    else delete country.placeholder;
  }
});

test('互免规则元信息原样反映已有证据，不把规则对象等同于入境许可', () => {
  const country = engine.COUNTRIES.items.GE;
  const descriptor = Object.getOwnPropertyDescriptor(country, 'mutualRule');
  const rule = { maxDays: 90, sourceUrl: 'https://example.test/mutual', cumulative: { maxDays: 90, windowDays: 180 } };
  country.mutualRule = rule;
  try {
    const r = run({ countryCode: 'GE', stayDays: 45 });
    assertBlocked(r, 'mutual_review');
    assert.deepEqual(r.meta.mutual, { reviewRequired: true, ...rule });
    assert.doesNotMatch(JSON.stringify(r.points), /v\.p\.mutual/);
    assert.deepEqual(country.mutualRule, rule);
  } finally {
    if (descriptor) Object.defineProperty(country, 'mutualRule', descriptor);
    else delete country.mutualRule;
  }
});

test('同一输入必须给出同一结论（确定性）', () => {
  const input = { countryCode: 'FR', purpose: 'fam', stayDays: 12, port: 'PEK', next: 'home' };
  const a = run(input);
  const b = run(input);
  assert.deepEqual({ ...a, meta: null }, { ...b, meta: null });
});

test('默认值：不传可选项时按旅游/普通护照/10 天/浦东/回国', () => {
  const r = run({ countryCode: 'IT' });
  assert.deepEqual(r.meta.inputs, {
    countryCode: 'IT',
    passportType: 'ord',
    purpose: 'tour',
    stayDays: 10,
    port: 'PVG',
    next: 'home'
  });
});
