'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

function checkIntegrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
    throw new Error('SQLite 完整性检查失败：' + JSON.stringify(rows));
  }
}

async function main() {
  const [action, input, output] = process.argv.slice(2);
  if (!['backup', 'restore'].includes(action) || !input || !output || process.argv.length !== 5) {
    throw new Error('用法：node scripts/db-backup.js <backup|restore> <源数据库> <不存在的新目标路径>');
  }
  const source = path.resolve(input);
  const target = path.resolve(output);
  if (source === target) throw new Error('源路径和目标路径不能相同');

  const db = new DatabaseSync(source, { readOnly: true });
  try {
    checkIntegrity(db);
    // 独占创建，禁止覆盖既有数据库；目标父目录须已存在。
    const fd = fs.openSync(target, 'wx', 0o600);
    fs.closeSync(fd);
    await backup(db, target);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      checkIntegrity(copy);
    } finally {
      copy.close();
    }
    console.log(JSON.stringify({ ok: true, action, source, target, integrity: 'ok' }));
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
