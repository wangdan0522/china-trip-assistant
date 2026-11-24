'use strict';

/**
 * 免签 / 过境 / 互免 / 海南 资格判定引擎
 *
 * 设计原则：
 * 1. 纯函数：不读写文件、不依赖请求对象，输入相同则输出相同（now 可注入）。
 * 2. 结论只由规则决定，不由模型生成 —— 这是产品「引擎输出，非模型输出」的底座。
 * 3. 引擎不产出任何自然语言：只产出 **消息键 + 参数**（titleKey / whyParams / points[].key）。
 *    翻译由 i18n 层完成。这样加一种语言不需要碰判定逻辑，也不可能改错规则。
 * 4. 每条结论都带 policy 元信息（版本 / 依据 / 到期日 / 剩余天数），
 *    因为「能不能来」本身是有保质期的。
 */

const COUNTRIES = require('../data/countries.json');

// 政策机器字段（版本 / 依据 / 到期日）在所有语种包里必须一致，
// 由 tests/i18n.test.js 的 drift 检查守护；引擎只需读一份。
const POLICY = require('../data/i18n/en.json').policy;

const PASSPORT_TYPES = ['ord', 'other'];
const PURPOSES = ['tour', 'biz', 'fam', 'exg', 'tr', 'work'];
const PORTS = {
  PVG: { en: 'Shanghai Pudong', hainan: false },
  PEK: { en: 'Beijing Capital', hainan: false },
  CAN: { en: 'Guangzhou Baiyun', hainan: false },
  HAK: { en: 'Haikou (Hainan)', hainan: true },
  SYX: { en: 'Sanya (Hainan)', hainan: true },
  SZX: { en: "Shenzhen Bao'an", hainan: false }
};
const NEXT = ['home', 'third'];

class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.status = 400;
  }
}

function toInt(v, field, min, max) {
  const n = v;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new ValidationError(field, `${field} must be an integer`);
  }
  if (n < min || n > max) {
    throw new ValidationError(field, `${field} must be between ${min} and ${max}`);
  }
  return n;
}

function pick(v, allowed, field) {
  if (!allowed.includes(v)) {
    throw new ValidationError(field, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return v;
}

function daysBetween(fromISO, nowDate) {
  // 固定按北京时间自然日计算，避免宿主时区影响到期边界。
  const [y, m, d] = fromISO.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  const beijing = new Date(nowDate.getTime() + 8 * 60 * 60 * 1000);
  const today = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate());
  return Math.round((end - today) / 86400000);
}

/**
 * 校验并规范化输入。任何越界输入都拒绝，不做「猜测式纠错」。
 */
function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('body', 'JSON object required');
  }

  const countryCode = typeof raw.countryCode === 'string' ? raw.countryCode.toUpperCase() : '';
  if (!Object.hasOwn(COUNTRIES.items, countryCode)) {
    throw new ValidationError('countryCode', 'unknown country code');
  }

  return {
    countryCode,
    passportType: pick(raw.passportType === undefined ? 'ord' : raw.passportType, PASSPORT_TYPES, 'passportType'),
    purpose: pick(raw.purpose === undefined ? 'tour' : raw.purpose, PURPOSES, 'purpose'),
    stayDays: toInt(raw.stayDays === undefined ? 10 : raw.stayDays, 'stayDays', 1, 180),
    port: pick(raw.port === undefined ? 'PVG' : raw.port, Object.keys(PORTS), 'port'),
    next: pick(raw.next === undefined ? 'home' : raw.next, NEXT, 'next')
  };
}

function blocked(route, date = null) {
  return {
    code: 'X',
    route,
    titleKey: route === 'policy_expired' ? 'v.blocked.title' : 'v.title.not_covered',
    whyKey: 'v.blocked.why',
    whyParams: { date: date || '—' },
    points: [{ key: 'v.blocked.point', tone: 'warn' }]
  };
}

/**
 * 主判定。
 * @param {object} raw 原始输入
 * @param {{now?: Date}} [options]
 * @returns {object} 结构化结论（消息键，不含自然语言）
 */
function evaluate(raw, options = {}) {
  const input = normalizeInput(raw);
  const now = options.now instanceof Date ? options.now : new Date();
  const c = COUNTRIES.items[input.countryCode];
  const isHainanPort = PORTS[input.port].hainan;
  const transitItinerary = input.purpose === 'tr' && input.next === 'third';

  const policyMeta = {
    version: COUNTRIES.version,
    checkedAt: COUNTRIES.checkedAt,
    authority: POLICY.source.authority,
    document: POLICY.source.document
  };

  let result;

  if (input.passportType !== 'ord' || input.countryCode === 'OK' || c.placeholder) {
    result = blocked('coverage_unknown');
  } else if (input.purpose === 'work') {
    result = {
      code: 'C',
      route: 'visa_required',
      titleKey: 'v.title.visa_required',
      whyKey: 'v.why.work',
      points: [
        { key: 'v.p.work.type' },
        { key: 'v.p.work.centre' },
        { key: 'v.p.work.lead' }
      ]
    };
  } else if (c.f) {
    // c.u 可能是具体日期、也可能是不设期限（文莱）。不能直接把「无期限」当日期算。
    const expires = c.u === '无期限' ? null : c.u || POLICY.expiry.unilateralTrial;
    const daysUntilExpiry = expires ? daysBetween(expires, now) : null;
    if (daysUntilExpiry !== null && daysUntilExpiry < 0) {
      result = {
        ...blocked('policy_expired', expires),
        policy: { ...policyMeta, expires, daysUntilExpiry }
      };
    } else if (input.stayDays <= 30) {
      const points = [
        { key: 'v.p.uni.days', params: { days: input.stayDays } },
        { key: 'v.p.uni.midnight' },
        { key: 'v.p.uni.ports' }
      ];
      if (c.t && transitItinerary) {
        points.push({ key: 'v.p.uni.vs_transit' });
      }
      if (expires) {
        points.push({ key: 'v.p.expiry.warn', params: { expires }, tone: 'warn' });
      } else {
        points.push({ key: 'v.p.expiry.none', tone: 'ok' });
      }
      points.push({ key: 'v.p.uni.evidence' });

      result = {
        code: 'A',
        route: 'unilateral',
        titleKey: 'v.title.unilateral',
        whyKey: 'v.why.unilateral',
        points,
        policy: { ...policyMeta, expires, daysUntilExpiry }
      };
    } else {
      result = {
        code: 'B',
        route: 'unilateral_overstay',
        titleKey: 'v.title.unilateral_over',
        whyKey: 'v.why.unilateral_over',
        whyParams: { country: input.countryCode, days: input.stayDays },
        points: [
          { key: 'v.p.uni.trim' },
          { key: 'v.p.uni.need_visa', params: { days: input.stayDays } },
          { key: 'v.p.uni.leave30' }
        ],
        policy: { ...policyMeta, expires, daysUntilExpiry }
      };
    }
  } else if (c.m) {
    // m 仅表示存在协定线索，不能据此推断停留期限或累计停留资格。
    // 现有互免消息键写死了 30 天；完成规则与文案核验前统一交人工复核。
    const rule = Object.hasOwn(c, 'mutualRule') ? c.mutualRule : null;
    result = {
      ...blocked('mutual_review'),
      meta: {
        mutual: {
          reviewRequired: true,
          maxDays: Number.isInteger(rule?.maxDays) && rule.maxDays > 0 ? rule.maxDays : null,
          sourceUrl: typeof rule?.sourceUrl === 'string' ? rule.sourceUrl : null,
          cumulative: rule?.cumulative ?? null
        }
      }
    };
  } else if (c.t && transitItinerary) {
    if (input.stayDays <= 10) {
      result = {
        code: 'A',
        route: 'transit240',
        titleKey: 'v.title.transit',
        whyKey: 'v.why.transit',
        whyParams: { country: input.countryCode },
        points: [
          { key: 'v.p.tr.days', params: { days: input.stayDays } },
          { key: 'v.p.tr.ticket' },
          { key: 'v.p.tr.ports' },
          { key: 'v.p.tr.provinces' },
          { key: 'v.p.tr.exclusions' }
        ]
      };
    } else {
      result = {
        code: 'B',
        route: 'transit240_overstay',
        titleKey: 'v.title.transit_over',
        whyKey: 'v.why.transit_over',
        whyParams: { days: input.stayDays },
        points: [{ key: 'v.p.tr.compress' }, { key: 'v.p.tr.visa' }]
      };
    }
  } else if (input.purpose === 'tr' && input.next === 'home' && c.t) {
    result = {
      code: 'B',
      route: 'transit_not_met',
      titleKey: 'v.title.transit_not_met',
      whyKey: 'v.why.transit_not_met',
      points: [
        { key: 'v.p.trn.qualify', params: { country: input.countryCode } },
        { key: 'v.p.trn.change' },
        { key: 'v.p.trn.normal' }
      ]
    };
  } else if (c.h && isHainanPort && input.stayDays <= 30) {
    result = {
      code: 'A',
      route: 'hainan',
      titleKey: 'v.title.hainan',
      whyKey: 'v.why.hainan',
      whyParams: { country: input.countryCode },
      points: [
        { key: 'v.p.hn.port' },
        { key: 'v.p.hn.only', tone: 'warn' }
      ]
    };
  } else {
    result = blocked('coverage_unknown');
  }

  return {
    ...result,
    policy: result.policy || policyMeta,
    meta: {
      ...result.meta,
      evaluatedAt: now.toISOString(),
      inputs: input,
      country: { code: input.countryCode },
      engine: 'policy-engine/1.1.0'
    }
  };
}

module.exports = {
  evaluate,
  normalizeInput,
  ValidationError,
  COUNTRIES,
  POLICY,
  PORTS,
  PASSPORT_TYPES,
  PURPOSES
};
