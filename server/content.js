'use strict';

/**
 * 内容服务：答疑、目的地、政策概览（按语种取包）
 *
 * 关键词匹配同时索引「当前语种 + 英文」两份关键词表：
 * 一个日本用户用英文打 "visa" 也要能命中，不能因为界面切了语言就丢掉英文输入能力。
 */

const i18n = require('./i18n');

function pack(lang) {
  return i18n.pack(lang);
}

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

/** 当前语种 + 英文的关键词并集 */
function keywordsFor(item, lang) {
  const set = new Set((item.k || []).map(norm).filter(Boolean));
  if (lang !== 'en') {
    const enItem = pack('en').qa.find((x) => x.id === item.id);
    if (enItem) (enItem.k || []).forEach((k) => set.add(norm(k)));
  }
  return [...set];
}

function match(text, lang) {
  const t = norm(text);
  if (!t) return null;

  const items = pack(lang).qa;
  let best = null;
  let bestScore = 0;

  for (const item of items) {
    let score = 0;
    for (const key of keywordsFor(item, lang)) {
      if (t.includes(key)) score += key.length >= 3 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore > 0 ? best : null;
}

function listQuestions(lang) {
  return pack(lang).qa.map((it) => ({
    id: it.id,
    action: it.action,
    q: it.q,
    needsEngine: it.yes === true
  }));
}

function shape(item, lang) {
  return {
    id: item.id,
    action: item.action,
    q: item.q,
    a: item.a,
    li: item.li || null,
    warn: item.warn || null,
    fees: item.fees || null,
    tips: item.tips || null,
    tail: item.tail || null,
    yes: item.yes || null,
    src: item.src,
    lang: pack(lang).code
  };
}

function fallback(lang) {
  return i18n.t(lang, 'ui.fallback.text').text;
}

/**
 * 按 id 精确取答案（快捷问题用这个，避免关键词误匹配）。
 */
function askById(id, lang) {
  const hit = pack(lang).qa.find((it) => it.id === id) || pack('en').qa.find((it) => it.id === id);
  if (!hit) return null;
  return { type: 'answer', item: shape(hit, lang) };
}

/**
 * @returns {{type:'answer'|'fallback', item?:object, fallback?:string, suggestions?:object[]}}
 */
function ask(text, lang) {
  const hit = match(text, lang);
  if (!hit) {
    return {
      type: 'fallback',
      fallback: i18n.t(lang, 'ui.fallback.text').text,
      suggestions: listQuestions(lang)
    };
  }
  return { type: 'answer', item: shape(hit, lang) };
}

function destinations(category, lang) {
  const d = pack(lang).dest;
  const cat = category && category !== 'all' ? category : null;
  return {
    version: d.version,
    checkedAt: d.checkedAt,
    disclaimer: d.disclaimer,
    categories: d.categories,
    seasons: d.seasons,
    items: cat ? d.items.filter((x) => x.cat === cat) : d.items
  };
}

function policyOverview(lang, now = new Date()) {
  const p = pack(lang).policy;
  const expires = p.expiry.unilateralTrial;
  // 与 policy-engine.daysBetween 保持一致：按自然日差，不按小时取整
  const [y, m, d] = expires.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const todayUTC = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate());
  const daysUntilExpiry = Math.round((end - todayUTC) / 86400000);
  return {
    ...p,
    lang: pack(lang).code,
    countdown: {
      expires,
      daysUntilExpiry,
      level: daysUntilExpiry < 0 ? 'expired' : daysUntilExpiry <= 60 ? 'critical' : daysUntilExpiry <= 180 ? 'soon' : 'normal'
    }
  };
}

module.exports = { ask, askById, listQuestions, destinations, policyOverview, match };
