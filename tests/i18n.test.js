'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const i18n = require('../server/i18n');
const content = require('../server/content');
const engine = require('../server/policy-engine');

const DIR = path.join(__dirname, '..', 'data', 'i18n');
const ALL = i18n.CODES;

function raw(code) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8'));
}

function placeholders(s) {
  return [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

/* ---------------- 覆盖面 ---------------- */

test('语言注册表与磁盘上的包一一对应', () => {
  for (const code of ALL) {
    const p = raw(code);
    assert.equal(p.code, code);
    assert.ok(p.native, `${code} 缺 native`);
    assert.ok(['native', 'draft', 'ai-reviewed'].includes(p.reviewStatus), `${code} reviewStatus 非法`);
    assert.ok(typeof p.reviewNote === 'string' && p.reviewNote.length > 20, `${code} 缺复核状态说明`);
    assert.equal(p.reviewStatus, ['en', 'zh'].includes(code) ? 'native' : 'ai-reviewed', `${code} 写作状态不准确`);
  }
});

test('每个语种的 ui / verdict 键集合与英文母版完全一致', () => {
  const base = raw('en');
  for (const code of ALL) {
    const p = raw(code);
    const missUi = Object.keys(base.ui).filter((k) => !(k in p.ui));
    const extraUi = Object.keys(p.ui).filter((k) => !(k in base.ui));
    const missV = Object.keys(base.verdict).filter((k) => !(k in p.verdict));
    const extraV = Object.keys(p.verdict).filter((k) => !(k in base.verdict));
    assert.deepEqual(extraV, [], `${code} 多出判定键`);
    assert.deepEqual(missUi, [], `${code} 缺 UI 键`);
    assert.deepEqual(extraUi, [], `${code} 多出 UI 键`);
    assert.deepEqual(missV, [], `${code} 缺判定键`);
  }
});

test('旅行首页纯 UI 文案在六语中完整，且不是中英文复制或未解析键', () => {
  const keys = [
    'app.tagline', 'exp.hero.badge', 'exp.hero.title', 'exp.hero.body', 'exp.heading', 'exp.sub',
    'home.account', 'home.browse', 'home.ask', 'home.destinations', 'home.destinations.sub',
    'home.view', 'home.detail.close', 'home.detail.title', 'home.detail.cta', 'home.detail.ask',
    'home.detail.note', 'home.entry.title', 'home.entry.sub', 'home.entry.policy',
    'home.entry.policy.sub', 'home.entry.prep', 'home.entry.prep.sub', 'home.entry.refund',
    'home.entry.refund.sub', 'home.footer', 'home.artNote', 'home.photoCredit',
    'home.detail.status', 'home.section.label', 'home.essentials.label', 'home.ask.cta'
  ];
  const english = raw('en').ui;
  const chinese = raw('zh').ui;
  const localScript = { zh: /\p{Script=Han}/u, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, ko: /\p{Script=Hangul}/u, ru: /\p{Script=Cyrillic}/u };
  assert.equal(ALL.length, 6, '必须覆盖六语');
  assert.equal(chinese['app.name'], '中国旅行助手');
  assert.equal(english['app.name'], 'China Inbound');
  for (const code of ALL) {
    const ui = raw(code).ui;
    for (const key of keys) {
      assert.ok(typeof ui[key] === 'string' && ui[key].trim(), `${code} 缺 ${key}`);
      assert.doesNotMatch(ui[key], /⟦|⟧/, `${code}/${key} 存在未解析键`);
      assert.equal(i18n.t(code, key).fallback, false, `${code}/${key} 不应依赖回退`);
      assert.equal(placeholders(ui[key]), '', `${code}/${key} 不应增加动态占位符`);
      if (code !== 'en') assert.notEqual(ui[key], english[key], `${code}/${key} 复制了英文`);
      if (code !== 'zh') assert.notEqual(ui[key], chinese[key], `${code}/${key} 复制了中文`);
      if (localScript[code]) assert.match(ui[key], localScript[code], `${code}/${key} 缺本语文字`);
      if (['en', 'es'].includes(code)) assert.doesNotMatch(ui[key], /\p{Script=Han}/u, `${code}/${key} 残留中文`);
    }
    assert.equal((ui['exp.hero.title'].match(/<br>/g) || []).length, 1, `${code} 首屏标题应保留一次换行`);
  }
});

test('重试与加载状态键在六语中存在并完整翻译', () => {
  for (const key of ['ui.retry', 'ui.status.loading']) {
    const translations = ALL.map((code) => {
      const ui = raw(code).ui;
      assert.ok(typeof ui[key] === 'string' && ui[key].trim(), `${code} 缺 ${key}`);
      assert.doesNotMatch(ui[key], /⟦|⟧/, `${code}/${key} 存在未解析键`);
      const result = i18n.t(code, key);
      assert.equal(result.fallback, false, `${code}/${key} 不应依赖回退`);
      assert.equal(result.text, ui[key]);
      return ui[key];
    });
    assert.equal(new Set(translations).size, ALL.length, `${key} 应分别本地化`);
  }
});

test('目的地提示在六语中本地化，不将主题灵感包装成已实测产品', () => {
  const disclaimers = ALL.map((code) => {
    const text = raw(code).dest.disclaimer;
    assert.ok(typeof text === 'string' && text.length > 20, `${code} 缺目的地提示`);
    assert.doesNotMatch(text, /⟦|⟧|verified/, `${code} 仍含未解析键或内部字段`);
    if (['en', 'es', 'ko', 'ru'].includes(code)) assert.doesNotMatch(text, /\p{Script=Han}/u, `${code} 残留中文`);
    return text;
  });
  assert.equal(new Set(disclaimers).size, ALL.length, '目的地提示应分别翻译');
  assert.equal(raw('zh').dest.disclaimer, '主题灵感仅供参考，预约与票务条目尚未逐个实测，订购前请向具体场馆确认。');
});

test('占位符在各语种中一一对应（不能翻译掉 {days}）', () => {
  const base = raw('en');
  for (const code of ALL) {
    const p = raw(code);
    for (const k of Object.keys(base.verdict)) {
      assert.equal(placeholders(base.verdict[k]), placeholders(p.verdict[k]), `${code} · ${k}`);
    }
    for (const k of Object.keys(base.ui)) {
      assert.equal(placeholders(base.ui[k]), placeholders(p.ui[k]), `${code} · ${k}`);
    }
  }
});

test('资料时效与退税提醒新增键在六语中完整翻译，且占位符符合约定', () => {
  const required = {
    'policy.countdown': 'date,days',
    'policy.expired': 'date',
    'policy.expiryLine': 'date,days,version',
    'policy.sources': '',
    'ui.tax.route': '',
    'ui.tax.agreementDeadline': '',
    'ui.tax.needsAgreement': '',
    'ui.tax.agreementStatus': '',
    'ui.tax.rateUnavailable': '',
    'ui.tax.feeUnknown': '',
    'ui.tax.amountInvalid': '',
    'dep.notice.port90': '',
    'dep.notice.needsAgreement': '',
    'dep.notice.agreementReminder': '',
    'dep.estimate.grossRange': ''
  };
  const base = raw('en').ui;
  assert.equal(ALL.length, 6, '必须覆盖六语');
  for (const code of ALL) {
    const ui = raw(code).ui;
    for (const [key, expected] of Object.entries(required)) {
      assert.ok(typeof ui[key] === 'string' && ui[key].trim(), `${code} 缺 ${key}`);
      assert.equal(placeholders(ui[key]), expected, `${code}/${key} 占位符不符约定`);
      if (code !== 'en') assert.notEqual(ui[key], base[key], `${code}/${key} 未翻译`);
    }
    assert.match(ui['dep.notice.port90'], /90/, `${code} 丢失90天提醒`);
    assert.match(ui['dep.notice.needsAgreement'], /28/, `${code} 丢失28天窗口说明`);
    assert.match(ui['dep.estimate.grossRange'], /8%–11%/, `${code} 丢失扣费前估算范围`);
  }
});

test('阻断说明不再依赖日期，未覆盖标题描述工具范围而非资格', () => {
  const tool = { en: /tool/i, zh: /本工具/, ja: /ツール/, ko: /도구/, es: /herramienta/, ru: /инструмент/ };
  for (const code of ALL) {
    const verdict = raw(code).verdict;
    for (const key of ['v.blocked.title', 'v.blocked.why', 'v.blocked.point', 'v.byline']) {
      assert.ok(verdict[key].length > 8, `${code}/${key} 缺说明`);
      assert.equal(placeholders(verdict[key]), '', `${code}/${key} 不应依赖运行时占位符`);
    }
    assert.match(verdict['v.title.not_covered'], tool[code], `${code} 未覆盖标题应描述工具范围`);
    assert.doesNotMatch(verdict['v.byline'], /2026|48|50/, `${code} 仍包含旧版数字依据`);
  }
});

test('准备类问答不保留未核验价格费率设备网点数字，求助号码保持不变', () => {
  const expectedIds = ['safety', 'phone', 'language', 'payment', 'cost', 'visa', 'help'];
  for (const code of ALL) {
    const pack = raw(code);
    assert.deepEqual(pack.qa.map((item) => item.id), expectedIds, `${code} 必须保留七条问答及顺序`);
    for (const id of ['language', 'payment', 'cost']) {
      const item = pack.qa.find((entry) => entry.id === id);
      const text = Object.entries(item).filter(([key]) => !['id', 'action', 'k'].includes(key)).map(([, value]) => JSON.stringify(value)).join(' ');
      assert.doesNotMatch(text, /\d|[%％]/, `${code}/${id} 不应用替换数字继续给出未经核验的承诺`);
    }
    const help = pack.qa.find((item) => item.id === 'help');
    assert.deepEqual(help.li.join(' ').match(/\d+/g), ['12367', '110', '120', '119'], `${code} 求助号码发生变化`);
    assert.doesNotMatch(pack.ui['dep.two.v1'], /28/, `${code} 不应自动以28天起算`);
    assert.match(pack.ui['dep.two.v2'], /90/, `${code} 口岸方式缺少90天`);
    assert.doesNotMatch(pack.ui['dep.merge'], /8[ ,]?000/, `${code} 仍有未核验门店统计`);
    assert.doesNotMatch(pack.ui['dep.before.body'], /28/, `${code} 仍声称统一28天起算`);
    assert.doesNotMatch(pack.ui['ui.tax.deadline_row'], /28/, `${code} 提醒标题仍有固定28天`);
    assert.doesNotMatch(pack.ui['ui.tax.over'], /28|late fee|滞纳金|延滞|지연 수수료|multa|штраф/i, `${code} 仍推断处罚`);
  }
});

test('答疑条目结构一致：id / 顺序 / 字段集合', () => {
  const base = raw('en');
  for (const code of ALL) {
    const p = raw(code);
    assert.equal(p.qa.length, base.qa.length, `${code} 条数不一致`);
    p.qa.forEach((it, i) => {
      assert.equal(it.id, base.qa[i].id, `${code} 第 ${i} 条 id 不一致`);
      assert.deepEqual(Object.keys(it).sort(), Object.keys(base.qa[i]).sort(), `${code}/${it.id} 字段不一致`);
      assert.ok(it.k.length >= base.qa[i].k.length, `${code}/${it.id} 关键词变少`);
    });
  }
});

test('没有未翻译的占位符残留（⟦key⟧）', () => {
  for (const code of ALL) {
    const text = JSON.stringify(raw(code));
    assert.equal(text.includes('⟦'), false, `${code} 有未解析的文案键`);
  }
});

test('非英文语种不是英文的复制粘贴（抽查差异率）', () => {
  const base = raw('en').ui;
  for (const code of ALL.filter((c) => c !== 'en')) {
    const p = raw(code).ui;
    const keys = Object.keys(base).filter((k) => base[k].length > 24);
    const same = keys.filter((k) => p[k] === base[k]).length;
    const ratio = same / keys.length;
    assert.ok(ratio < 0.15, `${code} 与英文重复率 ${(ratio * 100).toFixed(0)}%，疑似没翻译`);
  }
});

test('内容包的语言标记与 HTML 语言属性一致', () => {
  const p = i18n.pack('ja');
  assert.equal(p.code, 'ja');
  assert.equal(p.dir, 'ltr');
  assert.equal(i18n.pack('xx').code, 'en', '未知语种应回退英文');
});

test('云功能实际引用的键在六语中完整本地化', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const sources = ['app.js', 'cloud.js', 'index.html'].map((file) => fs.readFileSync(path.join(publicDir, file), 'utf8')).join('\n');
  const keys = [...new Set([...sources.matchAll(/["']((?:auth|cloud|history|feedback|ai)\.[\w.]+)["']/g)].map((match) => match[1]))];
  assert.ok(keys.length >= 30, '未提取到完整的云功能文案');
  const base = raw('en').ui;
  for (const code of ALL) {
    const ui = raw(code).ui;
    for (const key of keys) {
      assert.ok(typeof ui[key] === 'string' && ui[key].trim(), `${code} 缺 ${key}`);
      if (code !== 'en') assert.notEqual(ui[key], base[key], `${code}/${key} 复制了英文`);
    }
    assert.equal(placeholders(ui['auth.resendIn']), 'seconds');
    assert.ok(ui['history.snapshot'].length > 20, `${code} 缺历史快照说明`);
  }
});

test('本地问答关键词保留，各语言仍能命中本地常用词', () => {
  const keywords = {
    en: ['safety', 'phone', 'language', 'pay', 'cost', 'visa', 'emergency'],
    zh: ['安全', '手机', '翻译', '支付', '预算', '签证', '求助'],
    ja: ['治安', 'スマホ', '言葉', '支払い', '費用', 'ビザ', '緊急'],
    ko: ['치안', '휴대폰', '언어', '결제', '비용', '비자', '응급'],
    es: ['seguridad', 'celular', 'idioma', 'pago', 'coste', 'pasaporte', 'emergencia'],
    ru: ['безопасность', 'телефон', 'язык', 'оплата', 'стоимость', 'виза', 'помощь']
  };
  for (const code of ALL) {
    raw(code).qa.forEach((item, index) => {
      assert.ok(item.k.includes(keywords[code][index]), `${code}/${item.id} 丢失本地关键词`);
      for (const keyword of raw('en').qa[index].k) {
        assert.ok(item.k.includes(keyword), `${code}/${item.id} 丢失共用关键词 ${keyword}`);
      }
    });
  }
});

/* ---------------- 渲染 ---------------- */

test('判定结论在六个语种下都能渲染成整句，且不含未解析标记', () => {
  const verdict = engine.evaluate(
    { countryCode: 'DE', purpose: 'tour', stayDays: 10 },
    { now: new Date('2026-11-13T00:00:00Z') }
  );
  for (const code of ALL) {
    const r = i18n.renderVerdict(verdict, code);
    assert.ok(r.title.length > 2, `${code} 标题为空`);
    assert.equal(r.title.includes('⟦'), false);
    assert.equal(r.why.includes('⟦'), false);
    assert.equal(r.points.length, verdict.points.length);
    for (const p of r.points) assert.equal(p.text.includes('⟦'), false);
    assert.equal(r.meta.i18n.lang, code);
  }
});

test('国家名用 ICU 本地化，而不是固定中文/代码', () => {
  assert.equal(i18n.countryName('DE', 'zh'), '德国');
  assert.equal(i18n.countryName('DE', 'en'), 'Germany');
  assert.notEqual(i18n.countryName('DE', 'ja'), 'DE');
  assert.notEqual(i18n.countryName('DE', 'ru'), 'DE');
  // 模板里的 {country} 也要被替换成目标语言
  const v = engine.evaluate({ countryCode: 'MX', purpose: 'tr', next: 'third', stayDays: 5 });
  const ja = i18n.renderVerdict(v, 'ja');
  assert.ok(ja.why.includes(i18n.countryName('MX', 'ja')), '日语结论里的国名没有被本地化');
});

test('参数替换：{days} 进入目标语言句子', () => {
  const v = engine.evaluate({ countryCode: 'DE', purpose: 'tour', stayDays: 45 });
  const en = i18n.renderVerdict(v, 'en');
  const es = i18n.renderVerdict(v, 'es');
  assert.ok(en.why.includes('45'));
  assert.ok(es.why.includes('45'));
  assert.ok(en.points.some((p) => p.text.includes('45')));
});

test('回退链：缺键时回退英文并打标，不返回空白', () => {
  const r = i18n.t('ja', 'this.key.does.not.exist');
  assert.equal(r.fallback, true);
  assert.match(r.text, /this\.key\.does\.not\.exist/);
});

test('语言协商：显式参数 > Accept-Language > 默认', () => {
  assert.equal(i18n.negotiate('ko', 'ja,en;q=0.8'), 'ko');
  assert.equal(i18n.negotiate(null, 'ru-RU,ru;q=0.9,en;q=0.8'), 'ru');
  assert.equal(i18n.negotiate(null, 'zh-TW'), 'zh');
  assert.equal(i18n.negotiate(null, 'de-DE,de;q=0.9'), 'en');
  assert.equal(i18n.negotiate('', ''), 'en');
});

/* ---------------- 内容本地化 ---------------- */

test('答疑按语种返回，且切到日语也能用英文关键词命中', () => {
  for (const code of ALL) {
    const byId = content.askById('payment', code);
    assert.equal(byId.type, 'answer');
    assert.equal(byId.item.lang, code);
    assert.ok(byId.item.a.length > 20);
  }
  const enHit = content.ask('how do I pay by card', 'ja');
  assert.equal(enHit.type, 'answer');
  assert.equal(enHit.item.id, 'payment');

  const jaHit = content.ask('治安は大丈夫ですか', 'ja');
  assert.equal(jaHit.type, 'answer', '日语关键词没有命中');
});

test('目的地内容按语种返回 6 条，结构不变', () => {
  for (const code of ALL) {
    const d = content.destinations('all', code);
    assert.equal(d.items.length, 6);
    assert.equal(d.categories.length, 6);
    assert.equal(d.seasons.length, 4);
    assert.equal(typeof d.items[0].booking.passportOnline, 'string');
  }
  assert.equal(content.destinations('his', 'zh').items.length, 2);
});

test('政策概览的倒计时按自然日算，且与引擎口径一致', () => {
  for (const code of ALL) {
    const p = content.policyOverview(code, new Date('2026-11-13T00:00:00Z'));
    assert.equal(p.expires || p.expiry.unilateralTrial, '2026-12-31');
    assert.equal(p.countdown.daysUntilExpiry, 48);
    assert.equal(p.countdown.level, 'critical');
    assert.equal(p.stats.length, 3);
    assert.equal(p.steps.length, 5);
  }
});

test('六个语种包里的政策机器字段完全一致（防止改了到期日只改一个语种）', () => {
  const base = raw('en').policy;
  for (const code of ALL) {
    const p = raw(code).policy;
    assert.equal(p.version, base.version, code + ' version 漂移');
    assert.equal(p.checkedAt, base.checkedAt, code + ' checkedAt 漂移');
    assert.deepEqual(p.expiry, base.expiry, code + ' expiry 漂移');
    assert.deepEqual(p.source, base.source, code + ' source 漂移');
  }
});

test('六语机器元数据与 countries 及 registry 的同名数据保持一致', () => {
  const dataDir = path.join(__dirname, '..', 'data');
  const countries = JSON.parse(fs.readFileSync(path.join(dataDir, 'countries.json'), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'policy-registry.json'), 'utf8'));
  assert.equal(countries.version, registry.version, 'countries 与 registry 的 version 不一致');
  assert.equal(countries.checkedAt, registry.checkedAt, 'countries 与 registry 的 checkedAt 不一致');
  const expiryRules = { unilateralTrial: 'unilateral-50', russia: 'unilateral-russia', brunei: 'unilateral-brunei' };
  const sourceUrls = [...new Set(Object.values(countries.sources).flat().map((source) => source.url))].sort();
  const registryUrls = new Set(registry.rules.flatMap((rule) => [rule.sourceUrl, ...(rule.sources || []).map((source) => source.url)]));
  for (const url of sourceUrls) assert.ok(registryUrls.has(url), 'countries 来源未在 registry 中登记');
  const flags = { unilateral: 'f', transit: 't', hainan: 'h' };
  for (const [category, flag] of Object.entries(flags)) {
    assert.equal(Object.values(countries.items).filter((item) => item[flag] === 1).length, countries.coverage[category], `${category} 数据计数漂移`);
  }
  for (const code of ALL) {
    const metadata = raw(code).policy;
    assert.equal(metadata.version, countries.version, `${code} version 与 countries 不一致`);
    assert.equal(metadata.version, registry.version, `${code} version 与 registry 不一致`);
    assert.equal(metadata.checkedAt, countries.checkedAt, `${code} checkedAt 与 countries 不一致`);
    assert.equal(metadata.checkedAt, registry.checkedAt, `${code} checkedAt 与 registry 不一致`);
    for (const [key, id] of Object.entries(expiryRules)) {
      const rule = registry.rules.find((item) => item.id === id);
      assert.ok(rule, `registry 缺 ${id}`);
      assert.equal(metadata.expiry[key], rule.expiresOn, `${code}/${key} 到期元数据漂移`);
    }
    assert.deepEqual(metadata.source.documents.map((source) => source.url).sort(), sourceUrls, `${code} 来源链接漂移`);
    assert.equal(Number(metadata.stats[0].value), countries.coverage.unilateral, `${code} 统计元数据漂移`);
  }
});

test('每个语种的兜底文案都存在', () => {
  for (const code of ALL) {
    assert.ok(content.ask('zzzzqqqq', code).fallback.length > 20, `${code} 缺兜底文案`);
  }
});
