'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
-- 草稿回路（调光回路）：容量为严格正数（瓦）
CREATE TABLE IF NOT EXISTS circuits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  capacity   REAL NOT NULL CHECK (capacity > 0),
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS lights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  REAL NOT NULL,
  circuit_id  INTEGER REFERENCES circuits(id),  -- 未分配回路为 NULL；未分配灯具不计入回路负载
  rated_watts REAL CHECK (rated_watts IS NULL OR rated_watts > 0) -- 额定瓦数：严格正数
);

CREATE TABLE IF NOT EXISTS cues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cue_no     INTEGER NOT NULL,
  light_id   INTEGER NOT NULL REFERENCES lights(id),
  time       REAL NOT NULL CHECK (time >= 0),
  target     REAL NOT NULL CHECK (target >= 0 AND target <= 100),
  duration   REAL NOT NULL CHECK (duration >= 0),
  UNIQUE (cue_no)
);

CREATE INDEX IF NOT EXISTS idx_cues_time ON cues (time, cue_no);
CREATE INDEX IF NOT EXISTS idx_cues_light ON cues (light_id);

-- 已发布的不可变演出版本
CREATE TABLE IF NOT EXISTS versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  created_at REAL NOT NULL,
  cue_count  INTEGER NOT NULL DEFAULT 0
);

-- 版本快照：发布时灯具与 Cue 的完整冻结副本（含回路归属与额定瓦数）
CREATE TABLE IF NOT EXISTS version_lights (
  version_id  INTEGER NOT NULL REFERENCES versions(id),
  light_id    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  pos         INTEGER NOT NULL,
  circuit_id  INTEGER,   -- 旧版本（本功能上线前发布）为 NULL：可播放但不产生回路负载
  rated_watts REAL
);

CREATE TABLE IF NOT EXISTS version_cues (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  cue_no     INTEGER NOT NULL,
  light_id   INTEGER NOT NULL,
  time       REAL NOT NULL,
  target     REAL NOT NULL,
  duration   REAL NOT NULL,
  pos        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_version_cues ON version_cues (version_id, time, cue_no);

-- 版本快照中的回路（容量随发布冻结）
CREATE TABLE IF NOT EXISTS version_circuits (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  circuit_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  capacity   REAL NOT NULL,
  pos        INTEGER NOT NULL
);

-- 临时调光记录：针对已发布版本建立，绑定版本快照，独立于草稿
CREATE TABLE IF NOT EXISTS rehearsal_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  label      TEXT NOT NULL,
  created_at REAL NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 0  -- 操作序列修订号：成功追加次数，过期提交按它判冲突
);

-- 记录中的操作序列（按 seq 追加顺序；同秒操作也按 seq 顺序生效）
CREATE TABLE IF NOT EXISTS record_ops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  INTEGER NOT NULL REFERENCES rehearsal_records(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  light_id   INTEGER NOT NULL,
  time       REAL NOT NULL CHECK (time >= 0),
  op_type    TEXT NOT NULL CHECK (op_type IN ('override', 'return')),
  target     REAL,                       -- 仅 override 需要：0～100 目标亮度
  duration   REAL NOT NULL CHECK (duration >= 0),
  UNIQUE (record_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_record_ops ON record_ops (record_id, seq);
`;

let db;

/** 旧数据卷迁移：CREATE TABLE IF NOT EXISTS 不会为既有表补列，这里按需 ALTER ADD COLUMN。 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function open(dbPath) {
  if (db) return db;
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // 既有卷升级（新卷列已在 SCHEMA 中，此处检查会跳过）
  ensureColumn('lights', 'circuit_id', 'circuit_id INTEGER');
  ensureColumn('lights', 'rated_watts', 'rated_watts REAL');
  ensureColumn('version_lights', 'circuit_id', 'circuit_id INTEGER');
  ensureColumn('version_lights', 'rated_watts', 'rated_watts REAL');
  return db;
}

function get() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

module.exports = { open, get };
