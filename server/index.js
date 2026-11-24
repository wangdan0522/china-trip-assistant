'use strict';

/**
 * 入境游 APP 后端服务
 *
 * 零外部依赖：只用 Node 内置模块（含全局 fetch），`node server/index.js` 就能跑。
 * 私人记录由前端官方云 SDK + 本人 RLS 保存；本地 SQLite 仅保留审计和旧反馈。
 * data/i18n 是受控内容快照，不是官方实时政策 API。
 *
 * 多语种：所有内容接口都吃 ?lang=（或 Accept-Language），内容包在 server/i18n.js 里统一回退。
 * 实时：所有实时数据都带 fetchedAt / stale / error，源挂了产品继续用缓存跑。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const engine = require('./policy-engine');
const content = require('./content');
const taxfree = require('./taxfree');
const store = require('./store');
const i18n = require('./i18n');
const live = require('./live');
const registry = require('./policy-registry');
const pkg = require('../package.json');

// 默认只监听本机；受控托管环境通过 HOST/PORT 显式设置监听地址。
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// 只在可信反向代理剥离外部同名头之后启用。
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// 仅在 TRUST_PROXY=1 时参与跨域判定；由受控托管环境的启动命令显式注入公网地址。
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
const CLOUD_ORIGIN = 'https://china-trip-assistant.app.workbuddy.host';
const SDK_SCRIPT = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PUBLIC_REAL = fs.realpathSync(PUBLIC_DIR);
const MAX_BODY = 32 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonld': 'application/ld+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// 所有内联事件已改成事件委托，因此脚本可以彻底禁掉 unsafe-inline。
// style-src 仍允许内联样式（卡片里有行内宽度/颜色，风险远低于脚本）。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'Content-Security-Policy':
    `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' ${SDK_SCRIPT}; connect-src 'self' ${CLOUD_ORIGIN}; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'self'`
};

/** 只在确实走 HTTPS 的响应上加 HSTS，避免本机 http 被浏览器错误缓存。 */
function secHeaders(res) {
  const h = { ...SECURITY_HEADERS };
  if (res.__secure) h['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  return h;
}

/* ---------------- 基础设施 ---------------- */

const hits = new Map(); // 单进程保护；多实例部署还须启用网关限流。
function rateLimited(ip, limit = 240) {
  const minute = Math.floor(Date.now() / 60000);
  if (hits.size > 5000) {
    for (const [key, row] of hits) if (row.minute !== minute) hits.delete(key);
    if (!hits.has(ip) && hits.size >= 10000) return true;
  }
  const old = hits.get(ip);
  const n = old && old.minute === minute ? old.n + 1 : 1;
  hits.set(ip, { minute, n });
  return n > limit;
}

function sendJSON(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Language': payload && payload.lang ? payload.lang : i18n.DEFAULT,
    ...secHeaders(res),
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      req.resume();
      return reject(Object.assign(new Error('JSON content type required'), { status: 415 }));
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        if (!tooLarge) reject(Object.assign(new Error('Body too large'), { status: 413 }));
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
        resolve(body);
      } catch {
        reject(Object.assign(new Error('JSON object required'), { status: 400 }));
      }
    });
    req.on('aborted', () => reject(Object.assign(new Error('Request aborted'), { status: 400 })));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch { return sendJSON(res, 400, { error: 'InvalidPath' }); }
  if (/[\u0000-\u001f\\]/.test(rel)) return sendJSON(res, 400, { error: 'InvalidPath' });
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { error: 'Forbidden' });
  let file;
  try {
    const real = await fs.promises.realpath(filePath);
    if (!real.startsWith(PUBLIC_REAL + path.sep)) return sendJSON(res, 403, { error: 'Forbidden' });
    const ext = path.extname(real).toLowerCase();
    if (!Object.hasOwn(MIME, ext)) return sendJSON(res, 404, { error: 'NotFound' });
    file = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = await file.stat();
    if (!st.isFile()) { await file.close(); return sendJSON(res, 404, { error: 'NotFound' }); }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': st.size,
      'Cache-Control': ['.html', '.js'].includes(ext) ? 'no-cache' : 'public, max-age=300',
      ...secHeaders(res)
    });
    if (req.method === 'HEAD') { await file.close(); return res.end(); }
    const stream = file.createReadStream();
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    if (file) { try { await file.close(); } catch { /* 已由流关闭。 */ } }
    if (res.headersSent) return res.destroy();
    return sendJSON(res, 404, { error: 'NotFound' });
  }
}

/** 语言解析：query 优先，其次 body，最后 Accept-Language */
function resolveLang(url, body, req) {
  return i18n.negotiate(
    (url && url.searchParams.get('lang')) || (body && body.lang),
    req.headers['accept-language']
  );
}

/** 取 verdict 字典里的句子（i18n.t 只查 ui 字典，这里单独走一层）。 */
function sayVerdict(lang, key, params) {
  const own = i18n.pack(lang).verdict[key];
  const base = i18n.pack(i18n.DEFAULT).verdict[key];
  return i18n.interpolate(own || base || `⟦${key}⟧`, params || {});
}

/**
 * 官网页面变化 → 只把规则标成「待人工复核」，绝不自动改写任何规则内容。
 * 这是产品红线：法律结论不能来自网页解析。
 */
let flaggedWatch = null;
function flagPolicyChanges(watch) {
  if (!watch || !watch.needsReview || flaggedWatch === watch.fetchedAt) return null;
  const result = registry.markReview({
    detail: `${watch.changedCount} official page(s) changed at ${watch.fetchedAt || 'unknown time'}`,
    store
  });
  // 持久化失败时保持内存拦截；不得把未落盘告警当作已可靠记录。
  if (store.health().writable) flaggedWatch = watch.fetchedAt;
  return result;
}

function requireAdmin(req, res, lang) {
  if (!registry.adminEnabled()) {
    sendJSON(res, 503, { error: 'AdminDisabled', lang });
    return false;
  }
  if (!registry.isAdmin(req.headers['x-admin-token'])) {
    sendJSON(res, 403, { error: 'Forbidden', lang });
    return false;
  }
  return true;
}

function ruleSources(rules, includeId = false) {
  const seen = new Set();
  return rules.flatMap((rule) => {
    const sources = Array.isArray(rule.sources) ? rule.sources
      : rule.sourceUrl ? [{ url: rule.sourceUrl, document: rule.document }] : [];
    return sources.filter((source) => {
      if (typeof source?.url !== 'string' || !source.url.trim() || seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    }).map((source) => ({ ...(includeId ? { id: rule.id } : {}), url: source.url, document: source.document }));
  });
}

/* ---------------- 路由 ---------------- */

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const lang = resolveLang(url, null, req);

  // --- 健康检查 ---
  if (pathname === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'inbound-app-api',
      version: pkg.version,
      uptimeSec: Math.round(process.uptime()),
      langs: i18n.CODES,
      data: {
        countries: Object.keys(engine.COUNTRIES.items).length,
        policyVersion: engine.COUNTRIES.version,
        qaItems: content.listQuestions('en').length
      },
      storage: { mode: store.health().mode, writable: store.health().writable },
      policy: {
        status: registry.health().status,
        ok: registry.health().ok,
        blocked: registry.health().counts.blocked,
        needsReview: registry.health().counts.needsReview,
        soonestExpiry: registry.health().soonestExpiry
      },
      live: live.health()
    });
  }

  // --- 支持的语言 + 各语种完整度 ---
  if (pathname === '/api/languages' && method === 'GET') {
    return sendJSON(res, 200, {
      default: i18n.DEFAULT,
      negotiated: lang,
      items: i18n.languages().map((l) => ({ ...l, coverage: { ...l.coverage, ...i18n.coverage(l.code) } }))
    });
  }

  // --- 该语种的 UI 文案字典（前端唯一文案来源）---
  if (pathname === '/api/ui' && method === 'GET') {
    const p = i18n.pack(lang);
    return sendJSON(res, 200, {
      lang: p.code,
      reviewStatus: p.reviewStatus,
      dir: p.dir || 'ltr',
      ui: p.ui
    });
  }

  // --- 元信息（政策版本与到期倒计时）---
  if (pathname === '/api/meta' && method === 'GET') {
    const p = i18n.pack(lang);
    return sendJSON(res, 200, {
      app: { name: pkg.name, version: pkg.version },
      lang: p.code,
      reviewStatus: p.reviewStatus,
      policy: content.policyOverview(lang),
      attribution: i18n.t(lang, 'live.refund_note').text
    });
  }

  // --- 国籍列表（国家名走 ICU，不维护对照表）---
  if (pathname === '/api/countries' && method === 'GET') {
    const items = engine.COUNTRIES.order
      .filter((code) => engine.COUNTRIES.items[code])
      .map((code) => ({
        code,
        name: i18n.countryName(code, lang),
        flags: {
          unilateral: !!engine.COUNTRIES.items[code].f,
          transit: !!engine.COUNTRIES.items[code].t,
          hainan: !!engine.COUNTRIES.items[code].h,
          mutual: !!engine.COUNTRIES.items[code].m
        }
      }));
    return sendJSON(res, 200, { version: engine.COUNTRIES.version, lang, items });
  }

  // --- 快捷问题 ---
  if (pathname === '/api/questions' && method === 'GET') {
    return sendJSON(res, 200, { lang, items: content.listQuestions(lang) });
  }

  // --- 目的地内容（与实时天气合并）---
  if (pathname === '/api/destinations' && method === 'GET') {
    const payload = content.destinations(url.searchParams.get('category'), lang);
    // 内容首屏不依赖外部天气；浏览器随后从 /api/live 补充带时间戳的数据。
    const weather = url.searchParams.get('weather') === '0'
      ? { ok: false, stale: true, items: [], fetchedAt: null, source: null, error: null }
      : await live.getWeather();
    const byId = new Map((weather.items || []).map((w) => [w.id, w]));
    return sendJSON(res, 200, {
      ...payload,
      lang,
      live: {
        ok: weather.ok,
        stale: weather.stale,
        fetchedAt: weather.fetchedAt,
        source: weather.source,
        error: weather.error
      },
      items: payload.items.map((d) => {
        const w = byId.get(d.id);
        return { ...d, weather: w ? { temp: w.temp, cat: w.cat, at: w.at } : null };
      })
    });
  }

  // --- 政策概览 ---
  if (pathname === '/api/policy' && method === 'GET') {
    return sendJSON(res, 200, content.policyOverview(lang));
  }

  // --- 政策体检：每条规则的生效/失效/复核状态 ---
  if (pathname === '/api/policy/health' && method === 'GET') {
    const h = registry.health();
    return sendJSON(res, 200, { ...h, lang });
  }

  // --- 政策变更台账（可审计）---
  if (pathname === '/api/policy/audit' && method === 'GET') {
    if (!requireAdmin(req, res, lang)) return;
    return sendJSON(res, 200, { items: store.policyLog(50), lang });
  }

  // --- 人工核对完新公告后，解除待复核标记（需要运维令牌）---
  if (pathname === '/api/policy/ack' && method === 'POST') {
    if (!requireAdmin(req, res, lang)) return;
    const body = await readBody(req);
    const out = registry.acknowledge({ ruleIds: body.ruleIds, evidence: body.evidence, by: body.by, detail: body.detail, store });
    return sendJSON(res, 200, { ok: true, ...out, health: registry.health(), lang });
  }

  // 旧 sid 不是身份凭据。私人记录只能通过云 SDK 的真实会话与本人 RLS 访问。
  if (pathname === '/api/history') {
    return sendJSON(res, 410, { error: 'LegacyHistoryDisabled', messageKey: 'cloud.signInRequired', lang });
  }

  // --- 实时数据总览 ---
  if (pathname === '/api/live' && method === 'GET') {
    const snap = await live.snapshot();
    flagPolicyChanges(snap.policyWatch);
    return sendJSON(res, 200, { ...snap, lang });
  }

  // --- 强制刷新某个实时源（演示/运维用）---
  if (pathname === '/api/live/refresh' && method === 'POST') {
    if (!requireAdmin(req, res, lang)) return;
    const body = await readBody(req);
    const target = String(body.source || 'all');
    if (!['weather', 'fx', 'policy', 'all'].includes(target)) {
      return sendJSON(res, 400, { error: 'ValidationError', field: 'source', lang });
    }
    const out = {};
    if (target === 'weather' || target === 'all') out.weather = await live.getWeather({ force: true });
    if (target === 'fx' || target === 'all') out.fx = await live.getFx({ force: true });
    if (target === 'policy' || target === 'all') {
      out.policyWatch = await live.getPolicyWatch({ force: true });
      const flagged = flagPolicyChanges(out.policyWatch);
      if (flagged) out.registryFlagged = flagged;
    }
    return sendJSON(res, 200, { ok: true, refreshed: Object.keys(out), ...out });
  }

  // --- 资格判定（带政策有效期闸门）---
  if (pathname === '/api/eligibility' && method === 'POST') {
    const body = await readBody(req);
    const l = resolveLang(url, body, req);
    const verdict = engine.evaluate(body);
    const ruleIds = registry.ruleIdsForVerdict(verdict, body);
    const g = registry.guard(new Date(), { ruleIds });

    // 只检查本路线依赖的规则；过期、缺失或待复核均停止给肯定结论。
    if (g.blocked || g.needsReview.length) {
      const first = g.expired[0] || {};
      return sendJSON(res, 200, {
        blocked: true,
        lang: l,
        code: 'X',
        route: 'policy_unavailable',
        title: sayVerdict(l, 'v.blocked.title'),
        why: sayVerdict(l, 'v.blocked.why', { date: first.expiresOn || '—' }),
        points: [{ tone: 'warn', text: sayVerdict(l, 'v.blocked.point') }],
        byline: sayVerdict(l, 'v.byline'),
        meta: { ...verdict.meta, i18n: { lang: l } },
        policy: { status: g.blocked ? 'blocked' : 'needs_review', blocked: g.expired, needsReview: g.needsReview, version: g.health.version },
        sources: ruleSources(g.health.rules, true)
      });
    }

    const out = i18n.renderVerdict(verdict, l);
    out.registry = {
      status: g.health.status,
      version: g.health.version,
      soonestExpiry: g.health.soonestExpiry
    };
    out.sources = ruleSources(g.health.rules, true);
    // 不接受客户端 sid 写入私人记录。用户主动保存时，前端 SDK 使用真实登录会话。
    return sendJSON(res, 200, out);
  }

  // --- 答疑 ---
  if (pathname === '/api/ask' && method === 'POST') {
    const body = await readBody(req);
    const l = resolveLang(url, body, req);

    // 两条入口：快捷问题走 id（精确），自由输入走 text（关键词匹配）
    if (body.id) {
      const byId = content.askById(String(body.id), l);
      if (!byId) {
        return sendJSON(res, 404, { error: 'NotFound', message: 'unknown question id', lang: l });
      }
      return sendJSON(res, 200, { ...byId, lang: l, meta: { mode: 'rules' } });
    }

    const text = typeof body.text === 'string' ? body.text.slice(0, 500) : '';
    if (!text.trim()) {
      return sendJSON(res, 400, { error: 'ValidationError', field: 'text', message: 'text or id is required', lang: l });
    }
    const answer = content.ask(text, l);
    return sendJSON(res, 200, {
      ...answer,
      lang: l,
      meta: {
        mode: 'rules', // 未配置模型时明确标注：规则匹配，不是大模型生成
        note: 'Answers come from a curated rule library with cited sources; no generative model is used.'
      }
    });
  }

  // --- 退税期限（+ 实时汇率估算）---
  if (pathname === '/api/taxfree' && method === 'POST') {
    const body = await readBody(req);
    const l = resolveLang(url, body, req);
    const out = taxfree.calc(body.shoppingDate, new Date(), l, body);
    const hasAmount = Object.hasOwn(body, 'amount');
    if (hasAmount && (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0 || body.amount > 1000000000)) {
      throw new engine.ValidationError('amount', 'amount must be a non-negative number no greater than 1000000000');
    }
    const currency = body.currency === undefined ? 'USD' : body.currency;
    if (typeof currency !== 'string' || !['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'RUB', 'AUD', 'CAD', 'SGD', 'HKD', 'THB', 'MYR'].includes(currency)) {
      throw new engine.ValidationError('currency', 'unsupported currency');
    }
    const taxRuleIds = out.route === 'instant' ? ['taxfree-port-90', 'taxfree-instant-28'] : ['taxfree-port-90'];
    const g = registry.guard(new Date(), { ruleIds: taxRuleIds });
    if (!g.ok) {
      return sendJSON(res, 200, { blocked: true, eligibilityConfirmed: false, route: out.route,
        deadline: null, daysLeft: null, status: 'policy_unavailable', messageKey: 'ui.serviceUnavailable',
        policy: { status: g.health.status, version: g.health.version },
        sources: ruleSources(g.health.rules), lang: l });
    }
    if (hasAmount && body.amount > 0) {
      const fx = await live.getFx();
      out.estimate = live.refundEstimate(body.amount, currency);
      if (!out.estimate) throw new engine.ValidationError('amount', 'amount cannot be estimated');
      out.estimate.rateSource = fx.source;
      out.estimate.rateOk = fx.ok;
    }
    return sendJSON(res, 200, { ...out, lang: l });
  }

  // --- 反馈（匿名，不含问题原文）---
  if (pathname === '/api/feedback' && method === 'POST') {
    const body = await readBody(req);
    if (!['safety', 'phone', 'language', 'payment', 'cost', 'visa', 'help'].includes(body.answerId) ||
        typeof body.helpful !== 'boolean' || !i18n.CODES.includes(body.lang)) {
      return sendJSON(res, 400, { error: 'ValidationError', messageKey: 'cloud.failed', lang });
    }
    const row = store.appendFeedback({ answerId: body.answerId, helpful: body.helpful, lang: body.lang });
    if (row.persisted !== true) {
      return sendJSON(res, 503, { ok: false, persisted: false, error: 'StorageUnavailable', messageKey: 'cloud.failed', lang });
    }
    return sendJSON(res, 201, { ok: true, persisted: true, storage: 'local', lang });
  }

  if (pathname === '/api/stats' && method === 'GET') {
    if (!requireAdmin(req, res, lang)) return;
    return sendJSON(res, 200, store.stats());
  }

  // --- 静态资源 ---
  // API 命名空间下不落到静态文件，避免 /api/xxx 返回 HTML
  if (pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { error: 'NotFound', path: pathname });
  }

  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }

  return sendJSON(res, 405, { error: 'Method not allowed' });
}

/* ---------------- 启动 ---------------- */

function createServer() {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '[invalid]';
    // 忽略未获信任的代理协议头，不让普通 HTTP 请求诱导浏览器缓存 HSTS。
    res.__secure = !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
    res.on('finish', () => {
      if (process.env.QUIET !== '1') console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) {
        return sendJSON(res, 400, { error: 'InvalidURL' });
      }
      // 固定基准，不让不可信 Host 头参与 URL 构造；查询参数不进日志。
      const url = new URL(req.url, 'http://localhost');
      pathname = url.pathname.replace(/[\u0000-\u001f\u007f]/g, '');
      // 受控反向代理（TRUST_PROXY=1）下用代理追加的最右侧客户端地址，避免全体访客共享限流桶。
      const forwarded = TRUST_PROXY ? req.headers['x-forwarded-for'] : undefined;
      const ip = typeof forwarded === 'string' && forwarded.trim()
        ? forwarded.split(',').pop().trim() || req.socket.remoteAddress || 'unknown'
        : req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) return sendJSON(res, 429, { error: 'TooManyRequests' }, { 'Retry-After': '60' });
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
        const scheme = res.__secure ? 'https' : 'http';
        // 可信代理可能改写 Host；优先用代理转发的原始主机名，否则用运维显式配置的公网 Origin。
        const fwdHost =
          TRUST_PROXY && typeof req.headers['x-forwarded-host'] === 'string' && req.headers['x-forwarded-host'].trim()
            ? req.headers['x-forwarded-host'].split(',')[0].trim()
            : null;
        const ownOrigin = new URL(`${scheme}://${fwdHost || req.headers.host || 'localhost'}`).origin;
        const publicOrigin = TRUST_PROXY && PUBLIC_ORIGIN ? new URL(PUBLIC_ORIGIN).origin : null;
        if (req.headers.origin !== ownOrigin && req.headers.origin !== publicOrigin) {
          return sendJSON(res, 403, { error: 'CrossOriginDenied' });
        }
      }
      await route(req, res, url);
    } catch (err) {
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
      if (status >= 500 && process.env.QUIET !== '1') console.error('Request failed:', status, err.name || 'Error');
      if (res.headersSent) return res.end();
      sendJSON(res, status, {
        error: status >= 500 ? 'ServiceUnavailable' : err.name === 'ValidationError' ? 'ValidationError' : 'RequestRejected',
        field: status < 500 ? err.field : undefined,
        messageKey: status >= 500 ? 'cloud.failed' : undefined,
        message: status < 500 ? err.message : undefined
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (require.main === module) {
  // 重启后恢复「待复核」标记，避免官网变化告警被重启抹掉
  const replayed = registry.replayAudit(store.latestPolicyEvents());
  const st = store.health();
  const ph = registry.health();

  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n  入境游 APP  http://${HOST}:${PORT}`);
    console.log(`  健康检查    http://${HOST}:${PORT}/api/health`);
    console.log(`  语种        ${i18n.CODES.join(' / ')}`);
    console.log(`  数据源      国家 ${Object.keys(engine.COUNTRIES.items).length} 个 · 政策版本 ${engine.COUNTRIES.version}`);
    console.log(`  存储        ${st.engine}（反馈 ${st.counts.feedback} · 历史 ${st.counts.history} · 台账 ${st.counts.policyAudit}）`);
    console.log(`  政策体检    ${ph.status} · ${ph.counts.active}/${ph.counts.total} 有效 · 待复核 ${ph.counts.needsReview} · 已过期 ${ph.counts.blocked}`);
    if (ph.soonestExpiry) console.log(`  最近到期    ${ph.soonestExpiry.id} ${ph.soonestExpiry.date}（还有 ${ph.soonestExpiry.days} 天）`);
    console.log(`  实时源      天气 MET Norway → Open-Meteo（双源）· 汇率 open.er-api.com · 政策监测 nia.gov.cn`);
    if (replayed) console.log(`  台账重放    恢复 ${replayed} 条待复核标记`);
    console.log('');

    // 预热：启动即抓一次，首屏不用等
    Promise.all([live.getWeather(), live.getFx(), live.getPolicyWatch()])
      .then(([, , watch]) => {
        flagPolicyChanges(watch);
        console.log('  实时源预热完成：', JSON.stringify(live.health()));
      })
      .catch((e) => console.warn('  实时源预热失败（不影响启动）：', e.message));
  });

  // 每 30 分钟复查一次政策源；过期状态每次请求实时算，不依赖定时器
  const timer = setInterval(async () => {
    try {
      const watch = await live.getPolicyWatch({ force: true });
      const flagged = flagPolicyChanges(watch);
      if (flagged) console.log('  官网变化 → 已标记待人工复核：', JSON.stringify(flagged.marked));
    } catch (e) {
      console.warn('  政策源定时检查失败（不影响服务）：', e.message);
    }
  }, 30 * 60 * 1000);
  timer.unref();

  const shutdown = () => {
    console.log('\n  正在关闭…');
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, PORT, HOST };
