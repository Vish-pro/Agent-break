import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type DB = Database.Database;

export interface DeviceRow {
  id: string;
  sign_pk: Buffer;
  name: string;
  push_token: string | null;
  created_at: number;
}

export interface MessageRow {
  id: string;
  sender: string;
  recipient: string;
  payload: string;
  created_at: number;
}

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'relay.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON'); // overwrite deleted ciphertext pages
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT PRIMARY KEY,
      sign_pk     BLOB NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      push_token  TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  BLOB PRIMARY KEY,
      device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      expires_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      sender      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      recipient   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_by_recipient ON messages(recipient, created_at);
    CREATE TABLE IF NOT EXISTS blobs (
      id          TEXT PRIMARY KEY,
      uploader    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      size        INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
  `);
  return db;
}
