'use strict';

const { ValidationError } = require('./policy-engine');

const DAY_MS = 86400000;
const WINDOW_DAYS = 90;
const INSTANT_WINDOW_DAYS = 28;
const THRESHOLD_CNY = 200;
// 2026-02-25办税问答：普通离境退税90日；2026-05-12通知仅明确即买即退28日期限。
const SOURCES = [
  { url: 'https://jiangxi.chinatax.gov.cn/art/2026/2/25/art_31172_1666768.html', publishedAt: '2026-02-25' },
  { url: 'https://shanghai.chinatax.gov.cn/zzzb/zcwj/202605/t480366.html', publishedAt: '2026-05-12' }
];

function parseDate(s, field = 'shoppingDate') {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValidationError(field, `${field} must be YYYY-MM-DD`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError(field, `${field} is not a real calendar date`);
  }
  return dt.getTime();
}

function iso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function calc(shoppingDate, now = new Date(), lang, options = {}) {
  return calcRequest({ ...options, shoppingDate }, now, lang);
}

function calcRequest(body, now = new Date(), lang) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body', 'JSON body required');
  }
  const route = body.route === undefined ? 'port' : body.route;
  if (!['port', 'instant'].includes(route)) throw new ValidationError('route', 'route must be port or instant');
  const bought = parseDate(body.shoppingDate);
  const today = parseDate(iso(now.getTime() + 8 * 60 * 60 * 1000));
  if (bought > today) throw new ValidationError('shoppingDate', 'shoppingDate cannot be in the future');
  const agreementDate = body.agreementDate == null ? null : parseDate(body.agreementDate, 'agreementDate');
  const agreementDeadline = body.agreementDeadline == null ? null : parseDate(body.agreementDeadline, 'agreementDeadline');
  if (agreementDate !== null && (agreementDate < bought || agreementDate > today)) {
    throw new ValidationError('agreementDate', 'agreementDate must be between shoppingDate and today');
  }
  if (agreementDeadline !== null && agreementDeadline < (agreementDate === null ? bought : agreementDate)) {
    throw new ValidationError('agreementDeadline', 'agreementDeadline cannot precede shoppingDate or agreementDate');
  }
  // 不从购物日或协议签署日自动推算即买即退截止日，只提醒用户填入的实际协议截止日。
  const deadline = route === 'port' ? bought + WINDOW_DAYS * DAY_MS : agreementDeadline;
  const daysLeft = deadline === null ? null : Math.round((deadline - today) / DAY_MS);
  const status = daysLeft === null ? 'needs_agreement' : daysLeft < 0 ? 'expired' : daysLeft <= 7 ? 'critical' : 'ok';
  const noticeKey = route === 'port' ? 'dep.notice.port90' : deadline === null ? 'dep.notice.needsAgreement' : 'dep.notice.agreementReminder';
  const i18n = lang ? require('./i18n') : null;
  const say = (key) => i18n ? i18n.t(lang, key).text : null;
  return {
    route,
    shoppingDate: iso(bought),
    deadline: deadline === null ? null : iso(deadline),
    deadlineBasis: route === 'port' ? 'shopping_date_90_days' : deadline === null ? null : 'user_supplied_agreement',
    agreementDate: agreementDate === null ? null : iso(agreementDate),
    agreementDeadline: agreementDeadline === null ? null : iso(agreementDeadline),
    windowDays: route === 'port' ? WINDOW_DAYS : INSTANT_WINDOW_DAYS,
    daysLeft,
    status,
    noticeKey,
    eligibilityConfirmed: false,
    timezone: 'Asia/Shanghai',
    thresholdCNY: THRESHOLD_CNY,
    routes: [
      { id: 'port', windowDays: WINDOW_DAYS, requiresCreditCardPreauth: false, labelKey: 'dep.two.k2', label: say('dep.two.k2') },
      { id: 'instant', windowDays: INSTANT_WINDOW_DAYS, requiresCreditCardPreauth: true, requiresAgreement: true, labelKey: 'dep.two.k1', label: say('dep.two.k1') }
    ],
    noteKey: noticeKey,
    note: null,
    sources: SOURCES
  };
}

module.exports = { calc, calcRequest, WINDOW_DAYS, INSTANT_WINDOW_DAYS, THRESHOLD_CNY };
