'use strict';

/** 默认使用 SQLite；文件模式须显式启用，内存模式仅供测试且不宣称持久化成功。 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.INBOUND_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.INBOUND_DB_FILE || path.join(DATA_DIR, 'inbound.db');
const FEEDBACK_FILE = process.env.INBOUND_FEEDBACK_FILE || path.join(DATA_DIR, 'feedback.jsonl');
const HISTORY_FILE = process.env.INBOUND_HISTORY_FILE || path.join(DATA_DIR, 'history.jsonl');
const AUDIT_FILE = process.env.INBOUND_AUDIT_FILE || path.join(DATA_DIR, 'policy-audit.jsonl');
const FORCE_MODE = process.env.INBOUND_STORAGE_MODE || '';

// 与 data/i18n/*.json 保持一致：6 个语种都要能分别统计。
const LANGS = ['en', 'zh', 'ja', 'ko', 'es', 'ru'];

let mode = null; // 'sqlite' | 'file' | 'memory' | 'unavailable'
let db = null;
let degradedReason = null;
let writable = false;
const mem = { feedback: [], history: [], audit: [] };

function normLang(v) {
  const code = String(v || 'en').toLowerCase();
  return LANGS.includes(code) ? code : 'en';
}

function nowISO() {
  return new Date().toISOString();
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function createTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      answer_id TEXT NOT NULL,
      helpful INTEGER NOT NULL,
      lang TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS judge_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      sid TEXT NOT NULL,
      country_code TEXT,
      purpose TEXT,
      stay_days INTEGER,
      port TEXT,
      route TEXT,
      code TEXT,
      lang TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_sid ON judge_history(sid, id DESC);
    CREATE TABLE IF NOT EXISTS policy_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
}

/** 把旧的 feedback.jsonl 一次性导入 SQLite，用 meta 标记防止重复导入。 */
function migrateJsonl(conn) {
  if (!fs.existsSync(FEEDBACK_FILE)) return 0;
  let n = 0;
  conn.exec('BEGIN IMMEDIATE');
  try {
    const done = conn.prepare("SELECT v FROM meta WHERE k = 'migrated_jsonl'").get();
    if (!done) {
      const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean);
      const ins = conn.prepare('INSERT INTO feedback (ts, answer_id, helpful, lang) VALUES (?, ?, ?, ?)');
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue; // 单行损坏不影响整体
        }
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        ins.run(String(row.ts || nowISO()), String(row.answerId || 'unknown').slice(0, 64), row.helpful ? 1 : 0, normLang(row.lang));
        n += 1;
      }
      conn.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('migrated_jsonl', String(n));
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return n;
}

function init() {
  if (mode) return mode;

  if (FORCE_MODE === 'memory') {
    mode = 'memory';
    degradedReason = 'explicit non-persistent test mode';
    return mode;
  }

  let conn;
  try {
    if (FORCE_MODE === 'file') {
      for (const file of [FEEDBACK_FILE, HISTORY_FILE, AUDIT_FILE]) {
        ensureParent(file);
        fs.appendFileSync(file, '', 'utf8');
      }
      mode = 'file';
    } else {
      if (FORCE_MODE && FORCE_MODE !== 'sqlite') throw new Error('invalid INBOUND_STORAGE_MODE');
      const { DatabaseSync } = require('node:sqlite');
      ensureParent(DB_FILE);
      conn = new DatabaseSync(DB_FILE);
      conn.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      createTables(conn);
      migrateJsonl(conn);
      db = conn;
      mode = 'sqlite';
    }
    writable = true;
  } catch (err) {
    if (conn) {
      try { conn.close(); } catch { /* 保留原始初始化错误 */ }
    }
    degradedReason = 'storage unavailable: ' + err.message;
    db = null;
    mode = 'unavailable';
    writable = false;
  }
  return mode;
}

/* ---------------- 通用统计 ---------------- */

function summarise(rows) {
  const out = { total: 0, helpful: 0, unhelpful: 0, byAnswer: Object.create(null), byLang: Object.create(null) };
  for (const row of rows) {
    const helpful = !!row.helpful;
    const answerId = String(row.answerId || row.answer_id || 'unknown');
    const lang = normLang(row.lang);
    out.total += 1;
    if (helpful) out.helpful += 1;
    else out.unhelpful += 1;
    out.byAnswer[answerId] = out.byAnswer[answerId] || { helpful: 0, unhelpful: 0 };
    out.byAnswer[answerId][helpful ? 'helpful' : 'unhelpful'] += 1;
    out.byLang[lang] = out.byLang[lang] || { helpful: 0, unhelpful: 0 };
    out.byLang[lang][helpful ? 'helpful' : 'unhelpful'] += 1;
  }
  return out;
}

function appendFile(file, row) {
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

function writeRow(collection, file, row, sql, values) {
  const m = init();
  if (m === 'memory') {
    if (collection === 'audit') row.id = mem.audit.length + 1;
    mem[collection].push({ ...row });
    return { ok: false, persisted: false, error: 'non-persistent test mode' };
  }
  if (m === 'unavailable') return { ok: false, persisted: false, error: degradedReason };
  try {
    if (m === 'sqlite') {
      const result = db.prepare(sql).run(...values);
      if (collection === 'audit') row.id = Number(result.lastInsertRowid);
    } else {
      if (collection === 'audit') {
        row.id = readFileRows(file).reduce((last, item, index) => Math.max(last, Number(item.id) || index + 1), 0) + 1;
      }
      appendFile(file, row);
    }
    return { ok: true, persisted: true };
  } catch (err) {
    writable = false;
    degradedReason = collection + ' write failed: ' + err.message;
    return { ok: false, persisted: false, error: err.message };
  }
}

function readFileRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* ---------------- 反馈 ---------------- */

function appendFeedback({ answerId, helpful, lang }) {
  const row = {
    ts: nowISO(),
    answerId: String(answerId || 'unknown').slice(0, 64),
    helpful: Boolean(helpful),
    lang: normLang(lang)
  };

  const result = writeRow('feedback', FEEDBACK_FILE, row,
    'INSERT INTO feedback (ts, answer_id, helpful, lang) VALUES (?, ?, ?, ?)',
    [row.ts, row.answerId, row.helpful ? 1 : 0, row.lang]);
  return { ...row, ...result };
}

function stats() {
  const m = init();
  if (m === 'sqlite') {
    const rows = db.prepare('SELECT answer_id, helpful, lang FROM feedback').all()
      .map((r) => ({ answerId: r.answer_id, helpful: !!r.helpful, lang: r.lang }));
    return summarise(rows);
  }
  if (m === 'file') return summarise(readFileRows(FEEDBACK_FILE));
  return summarise(m === 'memory' ? mem.feedback : []);
}

/* ---------------- 匿名判定历史 ---------------- */

function cleanSid(sid) {
  const s = String(sid || '');
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

function addHistory({ sid, countryCode, purpose, stayDays, port, route, code, lang }) {
  const safeSid = cleanSid(sid);
  if (!safeSid) return { skipped: true, reason: 'invalid sid' };

  const row = {
    ts: nowISO(),
    sid: safeSid,
    countryCode: String(countryCode || '').slice(0, 4).toUpperCase(),
    purpose: String(purpose || '').slice(0, 24),
    stayDays: Number.isFinite(Number(stayDays)) ? Number(stayDays) : null,
    port: String(port || '').slice(0, 8).toUpperCase(),
    route: String(route || '').slice(0, 40),
    code: String(code || '').slice(0, 4),
    lang: normLang(lang)
  };

  return writeRow('history', HISTORY_FILE, row,
    `INSERT INTO judge_history (ts, sid, country_code, purpose, stay_days, port, route, code, lang)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.ts, row.sid, row.countryCode, row.purpose, row.stayDays, row.port, row.route, row.code, row.lang]);
}

function getHistory(sid, limit = 5) {
  const m = init();
  const safeSid = cleanSid(sid);
  if (!safeSid) return { ok: true, items: [] };
  const n = Math.min(Math.max(Number(limit) || 5, 1), 20);

  if (m === 'sqlite') {
    const rows = db.prepare('SELECT * FROM judge_history WHERE sid = ? ORDER BY id DESC LIMIT ?').all(safeSid, n);
    return {
      ok: true,
      items: rows.map((r) => ({
        ts: r.ts, countryCode: r.country_code, purpose: r.purpose, stayDays: r.stay_days,
        port: r.port, route: r.route, code: r.code, lang: r.lang
      }))
    };
  }
  if (m === 'unavailable') return { ok: false, items: [], error: degradedReason };
  const rows = m === 'file' ? readFileRows(HISTORY_FILE) : mem.history;
  return {
    ok: true,
    items: rows.filter((r) => r.sid === safeSid).slice(-n).reverse().map((r) => ({
      ts: r.ts, countryCode: r.countryCode, purpose: r.purpose, stayDays: r.stayDays,
      port: r.port, route: r.route, code: r.code, lang: r.lang
    }))
  };
}

/* ---------------- 政策变更台账 ---------------- */

function logPolicy({ ruleId, event, detail }) {
  const row = {
    ts: nowISO(),
    ruleId: String(ruleId || 'unknown').slice(0, 80),
    event: String(event || 'note').slice(0, 40),
    detail: String(detail || '').slice(0, 500)
  };
  const result = writeRow('audit', AUDIT_FILE, row,
    'INSERT INTO policy_audit (ts, rule_id, event, detail) VALUES (?, ?, ?, ?)',
    [row.ts, row.ruleId, row.event, row.detail]);
  return { ...row, ...result };
}

function policyLog(limit = 20) {
  const m = init();
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  if (m === 'sqlite') {
    return db.prepare('SELECT id, ts, rule_id, event, detail FROM policy_audit ORDER BY id DESC LIMIT ?').all(n)
      .map((r) => ({ id: r.id, ts: r.ts, ruleId: r.rule_id, event: r.event, detail: r.detail }));
  }
  const rows = auditRows(m);
  return rows.slice(-n).reverse();
}

function auditRows(m) {
  const rows = m === 'file' ? readFileRows(AUDIT_FILE) : m === 'memory' ? mem.audit : [];
  return rows.map((row, index) => ({ ...row, id: Number(row.id) || index + 1 }));
}

/** 每条规则按存储 id 返回最新完整事件，不受历史展示数量上限影响。 */
function latestPolicyEvents() {
  const m = init();
  if (m === 'sqlite') {
    return db.prepare(`SELECT id, ts, rule_id, event, detail FROM policy_audit
      WHERE id IN (SELECT MAX(id) FROM policy_audit GROUP BY rule_id) ORDER BY id DESC`).all()
      .map((r) => ({ id: r.id, ts: r.ts, ruleId: r.rule_id, event: r.event, detail: r.detail }));
  }
  const latest = new Map();
  for (const row of auditRows(m)) {
    if (!latest.has(row.ruleId) || row.id > latest.get(row.ruleId).id) latest.set(row.ruleId, row);
  }
  return [...latest.values()].sort((a, b) => b.id - a.id);
}

/* ---------------- 状态 ---------------- */

function health() {
  const m = init();
  let counts = { feedback: 0, history: 0, policyAudit: 0 };
  try {
    if (m === 'sqlite') {
      counts = {
        feedback: db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,
        history: db.prepare('SELECT COUNT(*) AS n FROM judge_history').get().n,
        policyAudit: db.prepare('SELECT COUNT(*) AS n FROM policy_audit').get().n
      };
    } else if (m === 'file') {
      counts = {
        feedback: readFileRows(FEEDBACK_FILE).length,
        history: readFileRows(HISTORY_FILE).length,
        policyAudit: readFileRows(AUDIT_FILE).length
      };
    } else {
      counts = { feedback: mem.feedback.length, history: mem.history.length, policyAudit: mem.audit.length };
    }
  } catch (err) {
    writable = false;
    degradedReason = 'storage read failed: ' + err.message;
  }
  return {
    mode: m,
    engine: m === 'sqlite' ? 'SQLite (node:sqlite)' : m === 'file' ? 'JSONL files' : m === 'memory' ? 'in-memory' : 'unavailable',
    writable,
    degradedReason: degradedReason || null,
    dbFile: m === 'sqlite' ? path.basename(DB_FILE) : null,
    counts
  };
}

/** 仅测试使用：彻底重置存储层状态。 */
function reset() {
  try {
    if (db) db.close();
  } catch { /* ignore */ }
  db = null;
  mode = null;
  degradedReason = null;
  writable = false;
  mem.feedback = [];
  mem.history = [];
  mem.audit = [];
}

module.exports = {
  appendFeedback,
  stats,
  addHistory,
  getHistory,
  logPolicy,
  policyLog,
  latestPolicyEvents,
  health,
  reset,
  LANGS,
  FEEDBACK_FILE,
  DB_FILE
};
