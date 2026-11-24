'use strict';

/**
 * 政策规则台账 + 过期自动下架。
 *
 * 为什么必须做这一层：
 *   签证结论答错，代价是游客一张机票。政策有保质期，数据过期后继续给结论
 *   比不给结论更危险。所以规则一旦过了 expiresOn，判定引擎直接停止出结论，
 *   返回「已过期 · 需人工复核」，直到有人核对新公告并确认。
 *
 * 状态机：
 *   active       正常，可以给结论
 *   needs_review 官网内容变化或过了复核日 → 暂停本路线结论，人工复核后恢复
 *   expired      过了失效日 → 硬拦截，不给结论
 *   retired      人工下架 → 硬拦截
 *
 * 数据来源边界（重要，不要对外夸大）：
 *   国家移民管理局 / 外交部没有公开的结构化政策 API。本台账由人工核对录入，
 *   官网只做「页面内容哈希变化检测」，变化不会自动改写任何规则，
 *   只会把规则标成 needs_review 并写进审计台账。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const COUNTRIES = require('../data/countries.json');

const FILE = process.env.INBOUND_REGISTRY_FILE || path.join(__dirname, '..', 'data', 'policy-registry.json');
const ADMIN_TOKEN = process.env.POLICY_ADMIN_TOKEN || '';

let cache = null;
const overrides = new Map(); // ruleId -> { status, at, reason }（内存态，可被审计日志重放）

function load() {
  if (cache) return cache;
  cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return cache;
}

function dayOnly(iso) {
  if (!iso) return null;
  const s = String(iso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const parsed = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * 政策生效日/失效日按「北京时间」的自然日算。
 * 官方公告用的是北京时间，服务器可能在 UTC 沙箱，若用宿主本地时区会整整差一天，
 * 导致「到期当天」在不同机器上结论相反。这里统一固定 UTC+8。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
function today(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const bj = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function computeStatus(rule, now) {
  const t = today(now);
  const ov = overrides.get(rule.id);
  if (ov && ov.status === 'retired') return { status: 'retired', reason: ov.reason || 'manually retired', at: ov.at };
  if (rule.status === 'retired') return { status: 'retired', reason: 'manually retired', at: null };

  const exp = dayOnly(rule.expiresOn);
  if (rule.status === 'expired' || (exp && t > exp)) return { status: 'expired', reason: `expired on ${exp || 'registry'}`, at: exp };
  const from = dayOnly(rule.effectiveFrom);
  if (rule.status === 'pending' || (from && t < from)) return { status: 'pending', reason: `not effective until ${from || 'registry update'}`, at: from };

  if (ov && ov.status === 'needs_review') return { status: 'needs_review', reason: ov.reason || 'flagged for review', at: ov.at };
  const reviewed = ov && ov.status === 'reviewed';
  const due = dayOnly(reviewed ? ov.reviewDue : rule.reviewDue);
  if ((!reviewed && rule.status === 'needs_review') || (due && t > due)) {
    return { status: 'needs_review', reason: !reviewed && rule.status === 'needs_review' ? 'flagged for review' : `review overdue since ${due}`, at: due };
  }

  return { status: 'active', reason: null, at: null };
}

function rules(now = new Date()) {
  return load().rules.map((r) => {
    const c = computeStatus(r, now);
    const exp = dayOnly(r.expiresOn);
    const review = overrides.get(r.id);
    const reviewed = review?.status === 'reviewed';
    const sources = Array.isArray(r.sources) ? r.sources
      : r.sourceUrl ? [{ url: r.sourceUrl, document: r.document }] : [];
    const evidence = reviewed ? sources.find((source) => source?.url === review.sourceUrl) : null;
    const document = reviewed ? evidence?.document || (review.sourceUrl === r.sourceUrl ? r.document : null) : r.document;
    return {
      id: r.id,
      name: r.name,
      effectiveFrom: r.effectiveFrom,
      expiresOn: r.expiresOn,
      reviewDue: reviewed ? review.reviewDue : r.reviewDue,
      authority: r.authority,
      document,
      sourceUrl: reviewed ? review.sourceUrl : r.sourceUrl,
      sources: reviewed ? [{ url: review.sourceUrl, document }] : sources,
      checkedOn: reviewed ? review.checkedOn : r.checkedOn,
      status: c.status,
      reason: c.reason,
      daysToExpiry: exp ? daysBetween(today(now), exp) : null
    };
  });
}

function health(now = new Date(), { ruleIds } = {}) {
  let list = rules(now);
  if (ruleIds !== undefined) {
    const ids = Array.isArray(ruleIds) ? [...new Set(ruleIds)] : ['invalid-rule-selection'];
    const byId = new Map(list.map((rule) => [rule.id, rule]));
    list = ids.map((id) => byId.get(id) || {
      id, name: String(id), status: 'retired', reason: 'required rule missing from registry',
      expiresOn: null, daysToExpiry: null
    });
  }
  const count = (s) => list.filter((r) => r.status === s).length;
  const blocked = list.filter((r) => r.status === 'expired' || r.status === 'retired' || r.status === 'pending');
  const review = list.filter((r) => r.status === 'needs_review');
  const withExpiry = list.filter((r) => r.daysToExpiry !== null && r.daysToExpiry >= 0)
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

  return {
    version: load().version,
    checkedAt: load().checkedAt,
    checkedOn: today(now),
    status: blocked.length ? 'expired' : review.length ? 'review' : 'ok',
    ok: blocked.length === 0 && review.length === 0,
    counts: { total: list.length, active: count('active'), needsReview: review.length, blocked: blocked.length },
    soonestExpiry: withExpiry[0] ? { id: withExpiry[0].id, date: withExpiry[0].expiresOn, days: withExpiry[0].daysToExpiry } : null,
    blocked: blocked.map((r) => ({ id: r.id, name: r.name, expiresOn: r.expiresOn, reason: r.reason })),
    needsReview: review.map((r) => ({ id: r.id, name: r.name, reason: r.reason })),
    rules: list,
    sourceModel: '人工核对录入 + 官网变化检测（无官方结构化 API，变化不自动改写规则）'
  };
}

/** 判定前的闸门。blocked = 一律不给结论。 */
function guard(now = new Date(), options = {}) {
  const h = health(now, options);
  return {
    blocked: h.blocked.length > 0,
    ok: h.ok,
    expired: h.blocked,
    needsReview: h.needsReview,
    warnings: h.needsReview,
    health: h
  };
}

/** 仅选择实际结论依赖的规则，不能把退税或其他路线的期限套到所有签证上。 */
function ruleIdsForVerdict(verdict, body = {}) {
  const route = verdict && verdict.route;
  const input = verdict?.meta?.inputs || body;
  if (route === 'coverage_unknown') return [];
  if (['unilateral', 'unilateral_overstay', 'policy_expired'].includes(route)) {
    const code = String(input.countryCode || '').toUpperCase();
    if (!code) return ['missing-unilateral-country'];
    return [code === 'RU' ? 'unilateral-russia' : code === 'BN' ? 'unilateral-brunei' : 'unilateral-50'];
  }
  if (['mutual', 'mutual_overstay', 'mutual_review'].includes(route)) return ['mutual-agreements'];
  if (['transit240', 'transit240_overstay', 'transit_not_met'].includes(route)) return ['transit-240'];
  if (route === 'hainan') return ['hainan-30'];
  if (route === 'visa_required') {
    if (input.purpose === 'work' || (input.passportType && input.passportType !== 'ord')) return [];
    const country = COUNTRIES.items[String(input.countryCode || '').toUpperCase()];
    if (!country) return ['missing-visa-country'];
    // 普通签证提示不使用单方面免签期限，只检查附带建议依赖的路线。
    const ids = [];
    if (country.t) ids.push('transit-240');
    if (country.h) ids.push('hainan-30');
    return ids;
  }
  return ['unknown-verdict-route'];
}

/** 官网监测到变化时调用：只标待复核，绝不改规则内容。 */
function markReview({ ruleIds, detail, store }) {
  const ids = Array.isArray(ruleIds) && ruleIds.length
    ? ruleIds
    : load().rules.filter((r) => String(r.authority).includes('移民管理局')).map((r) => r.id);
  const at = new Date().toISOString();
  for (const id of ids) {
    if (!load().rules.some((r) => r.id === id)) continue;
    if (overrides.get(id)?.status === 'retired') continue;
    overrides.set(id, { status: 'needs_review', at, reason: detail || 'official page changed' });
    if (store) store.logPolicy({ ruleId: id, event: 'source_changed', detail: detail || 'official page changed' });
  }
  return { marked: ids, at };
}

function reviewError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateEvidence(rule, evidence, now) {
  if (!evidence || typeof evidence !== 'object' || evidence.ruleId !== rule.id) throw reviewError('每条规则必须提供独立公告证据');
  let url;
  try { url = new URL(evidence.sourceUrl); } catch { throw reviewError('公告链接无效'); }
  // 精确主机白名单，不能用任意 .gov.cn 或任意使领馆子域冒充本规则依据。
  const entryHosts = ['www.nia.gov.cn', 'en.nia.gov.cn', 'dk.china-embassy.gov.cn',
    'qa.china-embassy.gov.cn', 'www.gov.cn'];
  const mutualHosts = ['cs.mfa.gov.cn', 'www.mfa.gov.cn', 'qa.china-embassy.gov.cn'];
  const taxHosts = ['www.chinatax.gov.cn', 'www.customs.gov.cn',
    'jiangxi.chinatax.gov.cn', 'shanghai.chinatax.gov.cn'];
  const allowedHosts = rule.id === 'mutual-agreements' ? mutualHosts
    : (rule.engineFlags || []).includes('taxfree') ? taxHosts : entryHosts;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw reviewError('公告链接路径无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !allowedHosts.includes(url.hostname) ||
      pathname === '/' || pathname.endsWith('/') || /\/(?:index|default|home)(?:\.[^/]*)?$/i.test(pathname)) {
    throw reviewError('必须提供对应官方主机上的 HTTPS 公告链接，不能使用首页');
  }
  const checkedOn = dayOnly(evidence.checkedOn);
  const reviewDue = dayOnly(evidence.reviewDue);
  const t = today(now);
  if (!checkedOn || !reviewDue || checkedOn > t || reviewDue <= t ||
      daysBetween(checkedOn, reviewDue) > 366 || (rule.expiresOn && reviewDue > rule.expiresOn)) {
    throw reviewError('复核日期无效：核对日不得在未来，复核日须在未来一年范围内且不得超过失效日');
  }
  return { ruleId: rule.id, sourceUrl: url.href, checkedOn, reviewDue };
}

/** 证据校验不代表事实复核；只有审计持久化成功才解除待复核。 */
function acknowledge({ ruleIds, evidence, by, detail, store, now = new Date() }) {
  if (!Array.isArray(ruleIds) || !ruleIds.length || !Array.isArray(evidence)) throw reviewError('必须明确指定规则及逐规则公告证据');
  const ids = [...new Set(ruleIds)];
  const at = new Date(now).toISOString();
  const reviews = ids.map((id) => {
    const rule = load().rules.find((r) => r.id === id);
    if (!rule) throw reviewError(`未知规则：${id}`);
    if (['expired', 'pending', 'retired'].includes(computeStatus(rule, now).status)) {
      throw reviewError(`规则 ${id} 已硬拦截，不能通过复核延长或重新启用`, 409);
    }
    const matches = evidence.filter((item) => item && item.ruleId === id);
    if (matches.length !== 1) throw reviewError(`规则 ${id} 必须有且仅有一条公告证据`);
    const review = validateEvidence(rule, matches[0], now);
    const auditDetail = JSON.stringify({ ...review, by: by || 'operator', detail: detail || '' });
    if (auditDetail.length > 500) throw reviewError('复核证据过长，无法完整保存到审计日志');
    return { review, auditDetail };
  });
  const acknowledged = [];
  for (const { review, auditDetail } of reviews) {
    let result;
    try {
      result = store && store.logPolicy({ ruleId: review.ruleId, event: 'reviewed',
        detail: auditDetail });
    } catch { /* 写入失败时保留原状态。 */ }
    if (!result || result.persisted !== true) {
      const error = reviewError('复核审计未持久化，未解除该规则待复核状态', 503);
      error.acknowledged = acknowledged;
      throw error;
    }
    overrides.set(review.ruleId, { status: 'reviewed', at, ...review });
    acknowledged.push(review.ruleId);
  }
  return { acknowledged, at, by: by || 'operator' };
}

/** 从审计日志重放变化标记，避免重启后丢失「待复核」状态。 */
function replayAudit(log) {
  if (!Array.isArray(log)) return 0;
  const latest = new Map();
  for (const row of log) {
    if (!row || !row.ruleId || !['source_changed', 'reviewed', 'retired'].includes(row.event)) continue;
    const previous = latest.get(row.ruleId);
    const timestamp = Date.parse(row.ts);
    if (!Number.isFinite(timestamp)) continue;
    const previousTimestamp = previous ? Date.parse(previous.ts) : -Infinity;
    const idOrder = previous ? String(row.id || '').localeCompare(String(previous.id || ''), 'en', { numeric: true }) : 1;
    // 完全相同的排序键有歧义时按下架、待复核、确认的安全优先级处理。
    const priority = { reviewed: 0, source_changed: 1, retired: 2 };
    if (!previous || timestamp > previousTimestamp ||
        (timestamp === previousTimestamp && (idOrder > 0 ||
          (idOrder === 0 && priority[row.event] > priority[previous.event])))) {
      latest.set(row.ruleId, row);
    }
  }
  let n = 0;
  for (const [id, row] of latest) {
    const rule = load().rules.find((r) => r.id === id);
    if (!rule) continue;
    if (row.event === 'retired') {
      overrides.set(id, { status: 'retired', at: row.ts, reason: 'replayed from audit log' });
    } else if (row.event === 'reviewed') {
      try {
        const evidence = validateEvidence(rule, JSON.parse(row.detail), new Date(row.ts));
        overrides.set(id, { status: 'reviewed', at: row.ts, ...evidence });
        continue;
      } catch { /* 旧的无证据 reviewed 记录不能恢复放行。 */ }
      overrides.set(id, { status: 'needs_review', at: row.ts, reason: 'review audit evidence missing or invalid' });
      n += 1;
    } else {
      overrides.set(id, { status: 'needs_review', at: row.ts, reason: 'replayed from audit log' });
      n += 1;
    }
  }
  return n;
}

function isAdmin(token) {
  if (!ADMIN_TOKEN || typeof token !== 'string') return false;
  const actual = crypto.createHash('sha256').update(token).digest();
  const expected = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(actual, expected);
}

function reset() {
  cache = null;
  overrides.clear();
}

module.exports = {
  rules,
  health,
  guard,
  ruleIdsForVerdict,
  markReview,
  acknowledge,
  replayAudit,
  isAdmin,
  adminEnabled: () => !!ADMIN_TOKEN,
  reset,
  daysBetween,
  today
};
