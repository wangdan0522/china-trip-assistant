'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const STORE = path.join(__dirname, '..', 'server', 'store.js');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function probe(dir, code, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('INBOUND_')) delete env[key];
  }
  Object.assign(env, { INBOUND_DATA_DIR: dir }, extra);
  const source = `const s = require(${JSON.stringify(STORE)});\n${code}`;
  return JSON.parse(cp.execFileSync(process.execPath, ['-e', source], {
    cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim());
}

for (const mode of ['sqlite', 'file']) {
  test(`${mode}：独立进程写入退出后，新进程完整读回且历史不泄露 sid`, (t) => {
    const dir = sandbox(t);
    const env = { INBOUND_STORAGE_MODE: mode };
    const written = probe(dir, `
      const feedback = [];
      for (const lang of s.LANGS) feedback.push(s.appendFeedback({ answerId: 'answer', helpful: true, lang }));
      const history = s.addHistory({ sid: 'session-123456', countryCode: 'DE', stayDays: 12, route: 'sample' });
      const audit = s.logPolicy({ ruleId: 'rule-a', event: 'changed', detail: 'first' });
      console.log(JSON.stringify({ feedback, history, audit, health: s.health() }));
    `, env);
    assert.equal(written.health.mode, mode);
    assert.equal(written.health.writable, true);
    assert.equal(written.feedback.length, 6);
    for (const row of written.feedback) {
      assert.equal(row.persisted, true);
      assert.equal(row.ok, true);
    }
    assert.equal(written.history.persisted, true);
    assert.equal(written.audit.persisted, true);
    assert.equal(written.audit.id, 1);
    const read = probe(dir, `
      console.log(JSON.stringify({ stats: s.stats(), history: s.getHistory('session-123456'),
        other: s.getHistory('another-session'), log: s.policyLog(), latest: s.latestPolicyEvents(), health: s.health() }));
    `, env);
    assert.equal(read.stats.total, 6);
    for (const lang of ['en', 'zh', 'ja', 'ko', 'es', 'ru']) assert.equal(read.stats.byLang[lang].helpful, 1);
    assert.equal(read.history.items.length, 1);
    assert.equal(read.history.items[0].countryCode, 'DE');
    assert.equal(read.history.items[0].stayDays, 12);
    assert.equal(Object.hasOwn(read.history.items[0], 'sid'), false);
    assert.equal(Object.hasOwn(read.history.items[0], 'ip'), false);
    assert.equal(Object.hasOwn(read.history.items[0], 'name'), false);
    assert.deepEqual(read.other.items, []);
    assert.equal(read.log[0].detail, 'first');
    assert.equal(read.latest[0].id, 1);
    assert.deepEqual(read.health.counts, { feedback: 6, history: 1, policyAudit: 1 });
    if (mode === 'file') {
      assert.deepEqual(fs.readdirSync(dir).sort(), ['feedback.jsonl', 'history.jsonl', 'policy-audit.jsonl']);
    }
  });

  test(`${mode}：原型键按普通答案统计，未知语种归 en`, (t) => {
    const dir = sandbox(t);
    const data = probe(dir, `
      for (const answerId of ['__proto__', 'constructor', 'toString']) {
        s.appendFeedback({ answerId, helpful: true, lang: 'xx' });
        s.appendFeedback({ answerId, helpful: false, lang: 'zh' });
      }
      console.log(JSON.stringify(s.stats()));
    `, { INBOUND_STORAGE_MODE: mode });
    assert.equal(data.total, 6);
    for (const id of ['__proto__', 'constructor', 'toString']) {
      assert.deepEqual(data.byAnswer[id], { helpful: 1, unhelpful: 1 });
    }
    assert.equal(data.byLang.en.helpful, 3);
  });

  test(`${mode}：重放按 id 逐规则取最新完整事件，不截断到 100 条`, (t) => {
    const dir = sandbox(t);
    const data = probe(dir, `
      for (let i = 0; i < 130; i++) s.logPolicy({ ruleId: 'rule-' + i, event: 'changed', detail: 'detail-' + i });
      s.logPolicy({ ruleId: 'rule-0', event: 'reviewed', detail: 'latest' });
      console.log(JSON.stringify({ latest: s.latestPolicyEvents(), log: s.policyLog(500) }));
    `, { INBOUND_STORAGE_MODE: mode });
    assert.equal(data.latest.length, 130);
    assert.equal(data.log.length, 100);
    assert.deepEqual(data.latest[0], { ...data.latest[0], id: 131, ruleId: 'rule-0', event: 'reviewed', detail: 'latest' });
    assert.equal(typeof data.latest[0].ts, 'string');
    assert.equal(data.latest.find((r) => r.ruleId === 'rule-1').detail, 'detail-1');
  });
}

test('SQLite 迁移行与 meta 同事务：meta 写失败回滚，关闭连接后重启只迁移一次', (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'feedback.jsonl'), [
    JSON.stringify({ answerId: 'legacy', helpful: true, lang: 'ja' }), 'broken', 'null',
    JSON.stringify({ answerId: 'legacy-2', helpful: false, lang: 'ko' }), ''
  ].join('\n'));
  const failed = probe(dir, `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(s.DB_FILE);
    db.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TRIGGER fail_meta BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'meta failure'); END;");
    db.close();
    let closed = 0;
    const close = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function () { closed++; return close.call(this); };
    const health = s.health();
    const inspected = new DatabaseSync(s.DB_FILE);
    const count = inspected.prepare('SELECT COUNT(*) AS n FROM feedback').get().n;
    const meta = inspected.prepare('SELECT COUNT(*) AS n FROM meta').get().n;
    inspected.exec('DROP TRIGGER fail_meta');
    inspected.close();
    console.log(JSON.stringify({ health, count, meta, closed }));
  `);
  assert.equal(failed.health.mode, 'unavailable');
  assert.equal(failed.health.writable, false);
  assert.equal(failed.count, 0);
  assert.equal(failed.meta, 0);
  assert.equal(failed.closed, 2, '失败的初始化连接和检查连接均应关闭');
  for (let i = 0; i < 3; i++) {
    const read = probe(dir, `console.log(JSON.stringify({ health: s.health(), stats: s.stats() }));`);
    assert.equal(read.health.mode, 'sqlite');
    assert.equal(read.stats.total, 2, '重启不可重复导入反馈');
  }
});

test('SQLite 写入失败不藏到 memory，三类写入均报告失败且 health 不可写', (t) => {
  const dir = sandbox(t);
  const data = probe(dir, `
    s.health();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(s.DB_FILE);
    for (const table of ['feedback', 'judge_history', 'policy_audit']) {
      db.exec("CREATE TRIGGER fail_" + table + " BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(ABORT, 'write denied'); END;");
    }
    db.close();
    const feedback = s.appendFeedback({ answerId: 'lost', helpful: true });
    const history = s.addHistory({ sid: 'session-123456' });
    const audit = s.logPolicy({ ruleId: 'rule-a', event: 'changed' });
    console.log(JSON.stringify({ feedback, history, audit, health: s.health(), stats: s.stats(),
      items: s.getHistory('session-123456').items, latest: s.latestPolicyEvents() }));
  `);
  for (const row of [data.feedback, data.history, data.audit]) {
    assert.equal(row.ok, false);
    assert.equal(row.persisted, false);
    assert.match(row.error, /write denied/);
  }
  assert.equal(data.health.mode, 'sqlite');
  assert.equal(data.health.writable, false);
  assert.match(data.health.degradedReason, /write failed/);
  assert.equal(data.stats.total, 0);
  assert.deepEqual(data.items, []);
  assert.deepEqual(data.latest, []);
});

test('显式 file 模式写失败不转内存，独立路径覆盖全部文件', (t) => {
  const dir = sandbox(t);
  const files = ['feedback', 'history', 'audit'].map((name) => path.join(dir, name, 'rows.jsonl'));
  const env = { INBOUND_STORAGE_MODE: 'file', INBOUND_FEEDBACK_FILE: files[0], INBOUND_HISTORY_FILE: files[1], INBOUND_AUDIT_FILE: files[2] };
  const data = probe(dir, `
    s.health();
    const fs = require('node:fs');
    for (const file of ${JSON.stringify(files)}) { fs.unlinkSync(file); fs.mkdirSync(file); }
    console.log(JSON.stringify({ feedback: s.appendFeedback({ answerId: 'lost' }),
      history: s.addHistory({ sid: 'session-123456' }), audit: s.logPolicy({ ruleId: 'rule-a' }), health: s.health() }));
  `, env);
  for (const row of [data.feedback, data.history, data.audit]) {
    assert.equal(row.ok, false);
    assert.equal(row.persisted, false);
  }
  assert.equal(data.health.mode, 'file');
  assert.equal(data.health.writable, false);
  assert.equal(fs.existsSync(path.join(dir, 'inbound.db')), false);
});

test('SQLite 初始化失败默认 unavailable，绝不自动创建 fallback 文件', (t) => {
  const dir = sandbox(t);
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const data = probe(dir, `
    console.log(JSON.stringify({ health: s.health(), feedback: s.appendFeedback({ answerId: 'lost' }),
      history: s.addHistory({ sid: 'session-123456' }), audit: s.logPolicy({ ruleId: 'rule-a' }),
      stats: s.stats(), items: s.getHistory('session-123456'), latest: s.latestPolicyEvents() }));
  `, { INBOUND_DB_FILE: path.join(blocked, 'inbound.db') });
  assert.equal(data.health.mode, 'unavailable');
  assert.equal(data.health.writable, false);
  for (const row of [data.feedback, data.history, data.audit]) {
    assert.equal(row.ok, false);
    assert.equal(row.persisted, false);
  }
  assert.equal(data.stats.total, 0);
  assert.equal(data.items.ok, false);
  assert.deepEqual(data.latest, []);
  assert.deepEqual(fs.readdirSync(dir), ['blocked']);
});

test('memory 仅显式测试模式，ok=false persisted=false 且重启后清空', (t) => {
  const dir = sandbox(t);
  const env = { INBOUND_STORAGE_MODE: 'memory' };
  const data = probe(dir, `
    console.log(JSON.stringify({ feedback: s.appendFeedback({ answerId: 'test', helpful: true }),
      history: s.addHistory({ sid: 'session-123456' }), audit: s.logPolicy({ ruleId: 'rule-a' }),
      health: s.health(), stats: s.stats(), items: s.getHistory('session-123456').items, latest: s.latestPolicyEvents() }));
  `, env);
  for (const row of [data.feedback, data.history, data.audit]) {
    assert.equal(row.ok, false);
    assert.equal(row.persisted, false);
  }
  assert.equal(data.health.mode, 'memory');
  assert.equal(data.health.writable, false);
  assert.equal(data.stats.total, 1);
  assert.equal(data.items.length, 1);
  assert.equal(Object.hasOwn(data.items[0], 'sid'), false);
  assert.equal(data.latest[0].id, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
  const restarted = probe(dir, `console.log(JSON.stringify(s.health().counts));`, env);
  assert.deepEqual(restarted, { feedback: 0, history: 0, policyAudit: 0 });
});

test('官方 SQLite 备份 API：含未 checkpoint 的 WAL，恢复新路径后跨进程读回且不覆盖已有路径', (t) => {
  const dir = sandbox(t);
  const script = path.join(__dirname, '..', 'scripts', 'db-backup.js');
  const backupFile = path.join(dir, 'snapshot.db');
  const restoredFile = path.join(dir, 'restored.db');
  const result = probe(dir, `
    s.appendFeedback({ answerId: 'snapshot', helpful: true, lang: 'ru' });
    s.addHistory({ sid: 'session-123456', countryCode: 'DE' });
    s.logPolicy({ ruleId: 'rule-backup', event: 'changed', detail: 'snapshot detail' });
    const cp = require('node:child_process');
    const output = cp.execFileSync(process.execPath,
      [${JSON.stringify(script)}, 'backup', s.DB_FILE, ${JSON.stringify(backupFile)}], { encoding: 'utf8' });
    console.log(output.trim());
  `);
  assert.equal(result.integrity, 'ok');
  assert.equal(result.action, 'backup');
  const restored = JSON.parse(cp.execFileSync(process.execPath, [script, 'restore', backupFile, restoredFile], {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim());
  assert.equal(restored.integrity, 'ok');
  const read = probe(dir, `console.log(JSON.stringify({ stats: s.stats(), items: s.getHistory('session-123456').items, latest: s.latestPolicyEvents() }));`, {
    INBOUND_DB_FILE: restoredFile
  });
  assert.equal(read.stats.total, 1);
  assert.equal(read.stats.byLang.ru.helpful, 1);
  assert.equal(read.items[0].countryCode, 'DE');
  assert.equal(Object.hasOwn(read.items[0], 'sid'), false);
  assert.equal(read.latest[0].detail, 'snapshot detail');
  assert.equal(read.latest[0].id, 1);
  const before = fs.readFileSync(restoredFile);
  const denied = cp.spawnSync(process.execPath, [script, 'restore', backupFile, restoredFile], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /EEXIST/);
  assert.deepEqual(fs.readFileSync(restoredFile), before);
  const invalid = path.join(dir, 'invalid.db');
  const invalidTarget = path.join(dir, 'invalid-restored.db');
  fs.writeFileSync(invalid, 'invalid database');
  const corrupt = cp.spawnSync(process.execPath, [script, 'restore', invalid, invalidTarget], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(corrupt.status, 0);
  assert.equal(fs.existsSync(invalidTarget), false);
});

test('非法 sid 不写入、也不返回历史', (t) => {
  const dir = sandbox(t);
  const data = probe(dir, `console.log(JSON.stringify({ added: s.addHistory({ sid: 'bad<script>' }), items: s.getHistory('bad').items }));`);
  assert.equal(data.added.skipped, true);
  assert.deepEqual(data.items, []);
});
