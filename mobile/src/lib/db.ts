import type { MediaRef } from '@pvtchat/protocol';
import * as SQLite from 'expo-sqlite';
import { getDbKeyHex } from './secrets';

export type OutStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type InStatus = 'received' | 'read' | 'expired';

export interface MessageRow {
  seq: number;
  id: string;
  outgoing: 0 | 1;
  kind: 'text' | 'image' | 'audio';
  body: string | null;
  media: string | null; // JSON MediaRef
  local_uri: string | null;
  ts: number;
  status: OutStatus | InStatus;
  read_sent: 0 | 1;
}

export interface Message extends Omit<MessageRow, 'media'> {
  media: MediaRef | null;
}

export const toMessage = (r: MessageRow): Message => ({ ...r, media: r.media ? (JSON.parse(r.media) as MediaRef) : null });

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Opens the SQLCipher-encrypted local history. Key lives in the Keychain/Keystore. */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= (async () => {
    const key = await getDbKeyHex();
    const db = await SQLite.openDatabaseAsync('pvtchat.db');
    // Raw-key form skips PBKDF2; key is validated hex so interpolation is safe.
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS messages (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        id         TEXT NOT NULL UNIQUE,
        outgoing   INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        body       TEXT,
        media      TEXT,
        local_uri  TEXT,
        ts         INTEGER NOT NULL,
        status     TEXT NOT NULL,
        read_sent  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id         TEXT PRIMARY KEY,
        frame      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    return db;
  })().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

export async function closeAndDeleteDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    await db?.closeAsync();
    dbPromise = null;
  }
  await SQLite.deleteDatabaseAsync('pvtchat.db').catch(() => {});
}
