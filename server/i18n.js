'use strict';

/**
 * 多语种层
 *
 * 职责边界：
 * 1. 语言注册表 + 客户端语言协商（?lang= → Accept-Language → 默认 en）
 * 2. 内容包加载与回退（缺翻译回退 en，并标记 _fallback 供前端提示）
 * 3. 判定引擎的「消息键 + 参数」→ 目标语言整句
 *
 * 设计红线：政策类结论不在这里生成，只做「把引擎已经算好的结论翻译成人的语言」。
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'i18n');

const LANGS = [
  { code: 'en', label: 'English', native: 'English', dir: 'ltr' },
  { code: 'zh', label: 'Chinese', native: '简体中文', dir: 'ltr' },
  { code: 'ja', label: 'Japanese', native: '日本語', dir: 'ltr' },
  { code: 'ko', label: 'Korean', native: '한국어', dir: 'ltr' },
  { code: 'es', label: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'ru', label: 'Russian', native: 'Русский', dir: 'ltr' }
];

const CODES = LANGS.map((l) => l.code);
const DEFAULT = 'en';

const cache = new Map();

function pack(lang) {
  const code = CODES.includes(lang) ? lang : DEFAULT;
  if (cache.has(code)) return cache.get(code);
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8'));
  cache.set(code, raw);
  return raw;
}

/** 语言协商：显式参数 > Accept-Language > 默认 */
function negotiate(query, acceptHeader) {
  if (query && CODES.includes(String(query).toLowerCase())) return String(query).toLowerCase();

  const header = String(acceptHeader || '');
  const tags = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    const base = tag.split('-')[0];
    if (CODES.includes(base)) return base;
    // zh-Hant / zh-TW 也落到 zh（当前简体资源）
    if (base === 'zh') return 'zh';
  }
  return DEFAULT;
}

function has(p, key) {
  return p && p.ui && Object.prototype.hasOwnProperty.call(p.ui, key);
}

/** 取一条 UI 文案；缺翻译回退英文并记录 */
function t(lang, key, params) {
  const primary = pack(lang);
  let text;
  let fallback = false;

  if (has(primary, key)) {
    text = primary.ui[key];
  } else if (has(pack(DEFAULT), key)) {
    text = pack(DEFAULT).ui[key];
    fallback = true;
  } else {
    // 开发期显式暴露，而不是静默输出空白
    text = `⟦${key}⟧`;
    fallback = true;
  }
  return { text: interpolate(text, params), fallback };
}

function interpolate(text, params) {
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
  );
}

/** 国家/地区名：用 ICU 数据本地化；占位选项使用本语种明确标签。 */
let regionCache = new Map();
function countryName(code, lang) {
  if (code === 'OK') return ({ en: 'Other / not listed', zh: '其他 / 未列出',
    ja: 'その他 / 一覧にない', ko: '기타 / 목록에 없음', es: 'Otro / no figura en la lista',
    ru: 'Другое / нет в списке' })[lang] || 'Other / not listed';
  const key = lang + ':' + code;
  if (regionCache.has(key)) return regionCache.get(key);
  let name = code;
  try {
    name = new Intl.DisplayNames([lang], { type: 'region' }).of(code) || code;
  } catch {
    name = code;
  }
  regionCache.set(key, name);
  return name;
}

/**
 * 把引擎输出的 {titleKey, whyKey, whyParams, points:[{key,params,tone}]}
 * 转成可直接渲染的整句。
 */
function renderVerdict(result, lang) {
  const p = pack(lang);
  const v = p.verdict;
  const fallbackList = [];

  const say = (key, params) => {
    let text = v[key];
    if (text === undefined) {
      text = pack(DEFAULT).verdict[key];
      if (text !== undefined) fallbackList.push(key);
    }
    if (text === undefined) return `⟦${key}⟧`;
    return interpolate(text, params);
  };

  const withCountry = (params) =>
    params && params.country ? { ...params, country: countryName(params.country, lang) } : params;

  const points = (result.points || []).map((pt) => ({
    text: say(pt.key, withCountry(pt.params)),
    tone: pt.tone || 'neutral'
  }));

  return {
    ...result,
    title: say(result.titleKey, withCountry(result.whyParams)),
    why: say(result.whyKey, withCountry(result.whyParams)),
    points,
    byline: say('v.byline'),
    lang: pack(lang).code,
    meta: {
      ...result.meta,
      i18n: {
        lang: pack(lang).code,
        reviewStatus: pack(lang).reviewStatus,
        fallbackKeys: fallbackList
      }
    }
  };
}

/** 内容包元信息（前端语言切换器用） */
function languages() {
  return LANGS.map((l) => {
    const p = pack(l.code);
    return {
      code: l.code,
      label: l.label,
      native: p.native || l.native,
      dir: p.dir || l.dir,
      reviewStatus: p.reviewStatus,
      coverage: {
        ui: Object.keys(p.ui || {}).length,
        verdict: Object.keys(p.verdict || {}).length,
        qa: (p.qa || []).length
      }
    };
  });
}

/** 供测试与运维用：某语种相对 en 的缺口 */
function coverage(lang) {
  const base = pack(DEFAULT);
  const p = pack(lang);
  const missingUi = Object.keys(base.ui).filter((k) => !(k in p.ui));
  const missingVerdict = Object.keys(base.verdict).filter((k) => !(k in p.verdict));
  return {
    lang,
    missingUi,
    missingVerdict,
    qaCount: p.qa.length,
    baseQaCount: base.qa.length,
    complete: !missingUi.length && !missingVerdict.length && p.qa.length === base.qa.length
  };
}

module.exports = {
  LANGS,
  CODES,
  DEFAULT,
  pack,
  t,
  negotiate,
  countryName,
  renderVerdict,
  languages,
  coverage,
  interpolate
};
