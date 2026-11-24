'use strict';

/**
 * 实时数据层
 *
 * 外部定期更新数据；缓存刷新频率不代表源数据的观测或发布频率。
 *
 * 1) 天气（Open-Meteo，免密钥）—— 10 分钟 TTL，可缓存，失败降级到上一份好数据并标 stale。
 * 2) 汇率（open.er-api.com）—— 每日参考汇率，6小时缓存，用于退税总额参考折算。
 * 3) 政策源监测（国家移民管理局）—— 30 分钟 TTL。**只做变化检测，绝不自动改规则**：
 *    抓取政策相关标题 → 取哈希 → 与上次比对 → 变了就把「待人工复核」挂出来。
 *    法律结论不能来自 HTML 解析，这是产品红线。
 *
 * 全部函数永不抛异常：实时源挂了，产品要能继续用缓存跑。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCES = require('../data/sources.json');
const PLACES = require('../data/places.json');

const STATE_FILE = process.env.LIVE_STATE_FILE || path.join(process.env.INBOUND_DATA_DIR || path.join(__dirname, '..', 'data'), 'live-state.json');
const FAILURE_COOLDOWN_MS = 30 * 1000;
const pending = {};
const retryAfter = {};
let persistenceError = null;
const TTL = {
  weather: Number(process.env.LIVE_WEATHER_TTL_MS || 10 * 60 * 1000),
  fx: Number(process.env.LIVE_FX_TTL_MS || 6 * 60 * 60 * 1000),
  policy: Number(process.env.LIVE_POLICY_TTL_MS || 30 * 60 * 1000)
};
const TIMEOUT = Number(process.env.LIVE_TIMEOUT_MS || 8000);

// 便于测试注入
let impl = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now()
};

function configure(overrides) {
  impl = { ...impl, ...overrides };
}
function reset() {
  impl = { fetch: (...args) => globalThis.fetch(...args), now: () => Date.now() };
  state.weather = null;
  state.fx = null;
  state.policy = null;
  lastPolicyHashes = {};
  persistenceError = null;
  for (const key of Object.keys(retryAfter)) delete retryAfter[key];
}

const state = { weather: null, fx: null, policy: null };
let lastPolicyHashes = loadHashes();

function loadHashes() {
  try {
    const hashes = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.values(hashes).some((v) => typeof v !== 'string' || !/^[a-f0-9]{16}$/.test(v))) throw new Error('invalid hashes');
    return hashes;
  } catch (err) {
    if (err.code !== 'ENOENT') persistenceError = `state load failed: ${err.message}`;
    return {};
  }
}

function saveHashes(h) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(h, null, 2) + '\n', 'utf8');
    persistenceError = null;
  } catch (err) {
    persistenceError = `state persistence failed: ${err.message}`;
  }
}

function cachedRequest(key, options, load) {
  if (pending[key]) return pending[key];
  if (!options.force && retryAfter[key] > impl.now() && state[key]) return Promise.resolve(state[key]);
  pending[key] = load(options).then((result) => {
    if (result.error || result.stale) retryAfter[key] = impl.now() + FAILURE_COOLDOWN_MS;
    else delete retryAfter[key];
    return result;
  }).finally(() => { delete pending[key]; });
  return pending[key];
}

async function httpJSON(url) {
  const res = await impl.fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { accept: 'application/json', 'user-agent': 'inbound-app/1.1 (+policy-watch)' }
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function httpText(url) {
  const res = await impl.fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: {
      accept: 'text/html',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; inbound-app-watch/1.1)'
    }
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.text();
}

function fresh(bucket, ttl) {
  return bucket && bucket.ok && !bucket.stale && impl.now() - bucket.fetchedAt >= 0 && impl.now() - bucket.fetchedAt < ttl;
}

/* ------------------------------------------------------------ 天气 */

/**
 * 两个源互为备份（都免费、都无需密钥）：
 *   MET Norway（逐点请求）→ Open-Meteo（一次批量）
 * 理由很实际：不同网络环境下这两个源的可达性并不一致，单源会直接变成「天气永远不可用」。
 * 统一输出语义分类 cat，前端不需要认识 WMO 码或 symbol_code。
 */

const SYMBOL_CAT = [
  [/thunder/, 'storm'],
  [/snow|sleet/, 'snow'],
  [/^clearsky/, 'clear'],
  [/^fair/, 'clear'],
  [/^partlycloudy/, 'cloudy'],
  [/^cloudy/, 'cloudy'],
  [/fog/, 'fog'],
  [/drizzle/, 'drizzle'],
  [/lightrain|lightrainshowers/, 'drizzle'],
  [/rain|rainshowers/, 'rain']
];

function symbolToCat(code) {
  const c = String(code || '').toLowerCase();
  for (const [re, cat] of SYMBOL_CAT) if (re.test(c)) return cat;
  return null;
}

function wmoToCat(code) {
  if (!Number.isInteger(code)) return null;
  if (code === 0) return 'clear';
  if (code >= 1 && code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  return null;
}

function validWeatherTime(value, local = false) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const at = Date.parse(local && !/(Z|[+-]\d\d:\d\d)$/.test(value) ? `${value}+08:00` : value);
  return Number.isFinite(at) && impl.now() - at <= 6 * 60 * 60 * 1000 && at - impl.now() <= 60 * 60 * 1000;
}

async function metPlace(place) {
  const [lat, lon] = place.coord;
  const url = `${SOURCES.weather.primary.url}?lat=${lat}&lon=${lon}`;
  const raw = await httpJSON(url);
  const series = raw && raw.properties && raw.properties.timeseries;
  if (!Array.isArray(series) || !series.length) throw new Error('empty timeseries');
  const now = series[0];
  const d = (now.data && now.data.instant && now.data.instant.details) || {};
  const next = (now.data && (now.data.next_1_hours || now.data.next_6_hours) || {}).summary || {};
  if (!Number.isFinite(d.air_temperature) || !symbolToCat(next.symbol_code) || !validWeatherTime(now.time)) throw new Error('invalid or outdated weather observation');
  return {
    id: place.id,
    temp: typeof d.air_temperature === 'number' ? Math.round(d.air_temperature) : null,
    cat: symbolToCat(next.symbol_code),
    symbol: next.symbol_code || null,
    humidity: typeof d.relative_humidity === 'number' ? Math.round(d.relative_humidity) : null,
    wind: typeof d.wind_speed === 'number' ? Math.round(d.wind_speed) : null,
    at: now.time || null
  };
}

async function openMeteoBatch() {
  const lat = PLACES.places.map((p) => p.coord[0]).join(',');
  const lon = PLACES.places.map((p) => p.coord[1]).join(',');
  const url =
    `${SOURCES.weather.fallback.url}?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m&timezone=Asia%2FShanghai';
  const raw = await httpJSON(url);
  const rows = Array.isArray(raw) ? raw : [raw];
  return PLACES.places.map((p, i) => {
    const cur = (rows[i] && rows[i].current) || {};
    if (!Number.isFinite(cur.temperature_2m) || !wmoToCat(cur.weather_code) || !validWeatherTime(cur.time, true)) throw new Error('invalid or outdated weather observation');
    return {
      id: p.id,
      temp: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
      cat: wmoToCat(cur.weather_code),
      symbol: null,
      humidity: typeof cur.relative_humidity_2m === 'number' ? Math.round(cur.relative_humidity_2m) : null,
      wind: typeof cur.wind_speed_10m === 'number' ? Math.round(cur.wind_speed_10m) : null,
      at: cur.time || null
    };
  });
}

async function fetchWeather() {
  const attempts = [];

  // 1) 主源：MET Norway，逐点并发
  try {
    const settled = await Promise.allSettled(PLACES.places.map(metPlace));
    const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (ok.length >= Math.ceil(PLACES.places.length / 2)) {
      return { items: ok, provider: SOURCES.weather.primary.provider, providerId: SOURCES.weather.primary.id, sourceUrl: 'https://api.met.no/' };
    }
    attempts.push('met-no: ' + settled.filter((r) => r.status === 'rejected').length + ' places failed');
  } catch (err) {
    attempts.push('met-no: ' + err.message);
  }

  // 2) 备源：Open-Meteo，一次批量
  try {
    const items = await openMeteoBatch();
    return { items, provider: SOURCES.weather.fallback.provider, providerId: SOURCES.weather.fallback.id, sourceUrl: 'https://open-meteo.com/' };
  } catch (err) {
    attempts.push('open-meteo: ' + err.message);
    throw Object.assign(new Error(attempts.join(' | ')), { name: err.name });
  }
}

function getWeather(options = {}) {
  return cachedRequest('weather', options, loadWeather);
}

async function loadWeather({ force = false } = {}) {
  if (!force && fresh(state.weather, TTL.weather)) return state.weather;

  const prev = state.weather;
  try {
    const got = await fetchWeather();
    state.weather = {
      ok: true,
      provider: got.provider,
      providerId: got.providerId,
      source: got.provider,
      sourceUrl: got.sourceUrl,
      fetchedAt: impl.now(),
      items: got.items,
      stale: false,
      error: null
    };
  } catch (err) {
    state.weather = {
      ok: !!prev && prev.ok,
      provider: prev ? prev.provider : SOURCES.weather.primary.provider,
      source: prev ? prev.source : SOURCES.weather.primary.provider,
      sourceUrl: prev ? prev.sourceUrl : 'https://api.met.no/',
      fetchedAt: prev ? prev.fetchedAt : null,
      items: prev ? prev.items : [],
      stale: true,
      error: err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message
    };
  }
  return state.weather;
}

/* ------------------------------------------------------------ 汇率 */

const FX_WANTED = ['USD', 'EUR', 'GBP', 'JPY', 'KRW', 'RUB', 'AUD', 'CAD', 'SGD', 'HKD', 'THB', 'MYR'];

function getFx(options = {}) {
  return cachedRequest('fx', options, loadFx);
}

async function loadFx({ force = false } = {}) {
  if (!force && fresh(state.fx, TTL.fx)) return state.fx;

  const prev = state.fx;
  try {
    const raw = await httpJSON(SOURCES.fx.url);
    if (!raw || raw.result !== 'success' || raw.base_code !== 'CNY' || !raw.rates) throw new Error('unexpected payload');
    const updated = Date.parse(raw.time_last_update_utc);
    if (!Number.isFinite(updated) || impl.now() - updated > 48 * 60 * 60 * 1000 || updated - impl.now() > 60 * 60 * 1000) throw new Error('invalid or outdated rate timestamp');
    const rates = {};
    for (const c of FX_WANTED) if (Number.isFinite(raw.rates[c]) && raw.rates[c] > 0) rates[c] = raw.rates[c];
    if (!Object.keys(rates).length) throw new Error('no valid exchange rates');
    state.fx = {
      ok: true,
      base: 'CNY',
      source: 'open.er-api.com',
      fetchedAt: impl.now(),
      updatedAt: raw.time_last_update_utc || null,
      rates,
      stale: false,
      error: null
    };
  } catch (err) {
    state.fx = {
      ok: !!prev && prev.ok,
      base: 'CNY',
      source: 'open.er-api.com',
      fetchedAt: prev ? prev.fetchedAt : null,
      updatedAt: prev ? prev.updatedAt : null,
      rates: prev ? prev.rates : {},
      stale: true,
      error: err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message
    };
  }
  return state.fx;
}

/* ------------------------------------------------- 政策源变化检测 */

function extractPolicyTitles(html) {
  const kw = new RegExp(SOURCES.policyKeywords.join('|'));
  const titles = [];
  const re = /<a\b[^>]*>([\s\S]{4,90}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && kw.test(text) && !titles.includes(text)) titles.push(text);
    if (titles.length >= 60) break;
  }
  return titles;
}

function hashTitles(titles) {
  return crypto.createHash('sha256').update(titles.slice(0, 20).join('\n')).digest('hex').slice(0, 16);
}

function getPolicyWatch(options = {}) {
  return cachedRequest('policy', options, loadPolicyWatch);
}

async function loadPolicyWatch({ force = false } = {}) {
  if (!force && fresh(state.policy, TTL.policy)) return state.policy;

  const results = [];
  let changed = 0;

  for (const src of SOURCES.policy) {
    const row = {
      id: src.id,
      name: src.name,
      url: src.url,
      authority: src.authority,
      status: 'unreachable',
      hash: null,
      previousHash: lastPolicyHashes[src.id] || null,
      checkedAt: null,
      titleCount: 0,
      sample: [],
      error: null
    };
    try {
      const html = await httpText(src.url);
      const titles = extractPolicyTitles(html);
      if (!titles.length) throw new Error('no relevant titles; baseline unchanged');
      const hash = hashTitles(titles);
      row.hash = hash;
      row.titleCount = titles.length;
      row.sample = titles.slice(0, 5);
      row.checkedAt = impl.now();

      if (!row.previousHash) {
        row.status = 'baseline';
      } else if (row.previousHash === hash) {
        row.status = 'unchanged';
      } else {
        row.status = 'changed';
        changed += 1;
      }
      lastPolicyHashes[src.id] = hash;
    } catch (err) {
      row.error = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message;
      row.checkedAt = impl.now();
    }
    results.push(row);
  }

  saveHashes(lastPolicyHashes);

  const anyOk = results.some((r) => r.status !== 'unreachable');
  state.policy = {
    ok: anyOk,
    fetchedAt: impl.now(),
    needsReview: changed > 0,
    changedCount: changed,
    sources: results,
    stale: results.some((r) => r.status === 'unreachable'),
    persistenceError,
    error: persistenceError || (anyOk ? null : 'all sources unreachable')
  };
  return state.policy;
}

/* ------------------------------------------------------------ 退税估算 */

// 2026-02-25办税问答：适用13%/9%增值税税率的物品，退税率分别为11%/8%。
// 手续费未知时只给扣费前范围，不把假设的净额称作实际可到手金额。
const REFUND_GROSS_RATES = [0.08, 0.11];

function refundEstimate(amountCNY, currency = 'CNY') {
  if (typeof amountCNY !== 'number' && typeof amountCNY !== 'string') return null;
  const amount = Number(amountCNY);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const money = (v) => Math.round(v * 100) / 100;
  const grossMinCNY = money(amount * REFUND_GROSS_RATES[0]);
  const grossMaxCNY = money(amount * REFUND_GROSS_RATES[1]);
  if (!Number.isFinite(grossMinCNY) || !Number.isFinite(grossMaxCNY)) return null;
  const fx = state.fx;
  const updated = fx && Date.parse(fx.updatedAt);
  const usableFx = fresh(fx, TTL.fx) && Number.isFinite(updated) && impl.now() - updated <= 48 * 60 * 60 * 1000;
  const requestedCurrency = typeof currency === 'string' ? currency.toUpperCase() : '';
  const rate = requestedCurrency === 'CNY' ? 1 : usableFx && Object.hasOwn(fx.rates, requestedCurrency) ? fx.rates[requestedCurrency] : null;
  return {
    purchaseCNY: money(amount),
    grossMinCNY,
    grossMaxCNY,
    grossMinLocal: rate ? money(grossMinCNY * rate) : null,
    grossMaxLocal: rate ? money(grossMaxCNY * rate) : null,
    grossRates: REFUND_GROSS_RATES.slice(),
    feeKnown: false,
    refundCNY: null,
    refundLocal: null,
    rateApplied: rate,
    currency: requestedCurrency,
    conversionAvailable: rate !== null,
    rateStale: requestedCurrency !== 'CNY' && !!fx && !usableFx,
    rateAt: requestedCurrency === 'CNY' ? null : fx ? fx.updatedAt : null,
    noticeKey: 'dep.estimate.grossRange',
    sourceUrl: 'https://jiangxi.chinatax.gov.cn/art/2026/2/25/art_31172_1666768.html',
    sourcePublishedAt: '2026-02-25'
  };
}

/* ------------------------------------------------------------ 汇总 */

async function snapshot() {
  const [weather, fx, policy] = await Promise.all([getWeather(), getFx(), getPolicyWatch()]);
  return {
    serverTime: new Date(impl.now()).toISOString(),
    weather: { ...weather, ttlMs: TTL.weather, dataKind: 'weather_model', name: 'live.weather' },
    fx: { ...fx, ttlMs: TTL.fx, dataKind: 'daily_reference', name: 'live.fx' },
    policyWatch: { ...policy, ttlMs: TTL.policy, name: 'live.watch' }
  };
}

function health() {
  const row = (bucket, ttl) => ({
    ok: !!(bucket && bucket.ok),
    stale: !!((bucket && bucket.stale) || (bucket && !fresh(bucket, ttl))),
    ageSec: bucket && bucket.fetchedAt ? Math.round((impl.now() - bucket.fetchedAt) / 1000) : null,
    error: bucket ? bucket.error : 'not fetched yet'
  });
  return {
    weather: row(state.weather, TTL.weather),
    fx: row(state.fx, TTL.fx),
    policyWatch: { ...row(state.policy, TTL.policy), ok: !!(state.policy && state.policy.ok && !persistenceError), persistenceError },
    needsReview: !!(state.policy && state.policy.needsReview),
    ttl: TTL
  };
}

module.exports = {
  getWeather,
  getFx,
  getPolicyWatch,
  snapshot,
  health,
  refundEstimate,
  extractPolicyTitles,
  symbolToCat,
  wmoToCat,
  hashTitles,
  configure,
  reset,
  TTL,
  REFUND_GROSS_RATES
};
