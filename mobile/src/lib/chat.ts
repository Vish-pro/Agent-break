import {
  DecryptError,
  LIMITS,
  ServerFrame,
  open,
  openBlob,
  seal,
  sealBlob,
  type ClientFrame,
  type InnerPayload,
  type MediaRef,
} from '@pvtchat/protocol';
import * as Crypto from 'expo-crypto';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { Api, ApiError } from './api';
import { getDb, toMessage, type Message, type MessageRow } from './db';
import { deleteFile, prepareImage, readBytes, saveMedia } from './media';
import { boxKeys, type Identity, type Peer } from './secrets';
import { sodium } from './sodium';

export type ConnState = 'offline' | 'connecting' | 'online';

export interface ChatSnapshot {
  conn: ConnState;
  peerOnline: boolean;
  peerTyping: boolean;
  /** Bumps whenever stored messages change; screens re-query on change. */
  version: number;
  revoked: boolean;
}

type SendFrame = Extract<ClientFrame, { type: 'send' }>;

const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const TYPING_TTL_MS = 6_000;

/**
 * Owns the WebSocket, outbox and E2EE for the single conversation.
 * Lifecycle follows AppState: connected while foregrounded, closed in background
 * (push notifications cover the background case).
 */
export class ChatClient {
  readonly api: Api;
  private readonly me: Identity;
  private readonly peer: Peer;
  private readonly keys: ReturnType<typeof boxKeys>;

  private ws: WebSocket | null = null;
  private wantOnline = false;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: NativeEventSubscription | null = null;
  private readonly downloading = new Set<string>();
  /** Inbound frames are processed strictly in arrival order. */
  private frameQueue: Promise<void> = Promise.resolve();

  private snap: ChatSnapshot = { conn: 'offline', peerOnline: false, peerTyping: false, version: 0, revoked: false };
  private readonly listeners = new Set<() => void>();

  constructor(api: Api, peer: Peer) {
    this.api = api;
    this.me = api.me;
    this.peer = peer;
    this.keys = boxKeys(this.me, peer);
  }

  // ------------------------------------------------------------ store API (useSyncExternalStore)

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<ChatSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }
  private bump() {
    this.set({ version: this.snap.version + 1 });
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    this.appStateSub = AppState.addEventListener('change', this.onAppState);
    this.onAppState(AppState.currentState);
    void this.resumeDownloads();
  }

  stop() {
    this.appStateSub?.remove();
    this.wantOnline = false;
    this.teardown();
  }

  private onAppState = (s: AppStateStatus) => {
    if (s === 'active') {
      this.wantOnline = true;
      this.retry = 0;
      if (!this.ws) this.connect();
    } else if (s === 'background') {
      this.wantOnline = false;
      this.teardown();
    }
  };

  private teardown() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.set({ conn: 'offline', peerOnline: false, peerTyping: false });
  }

  private async connect() {
    if (!this.wantOnline || this.snap.revoked) return;
    this.set({ conn: 'connecting' });
    let token: string;
    try {
      token = await this.api.getToken(this.retry > 0);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unknown_device') return this.set({ revoked: true, conn: 'offline' });
      return this.scheduleReconnect();
    }
    if (!this.wantOnline) return;

    const ws = new WebSocket(this.api.wsUrl());
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token } satisfies ClientFrame));
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      const raw = String(ev.data);
      this.frameQueue = this.frameQueue.then(async () => void (await this.onFrame(raw))).catch((err) => console.warn('frame error', err));
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return; // stale socket
      this.ws = null;
      this.clearHeartbeat();
      this.set({ conn: 'offline', peerOnline: false, peerTyping: false });
      if (ev.code === 4003) return this.set({ revoked: true });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (!this.wantOnline || this.reconnectTimer) return;
    const base = Math.min(30_000, 1000 * 2 ** this.retry);
    const delay = base / 2 + Math.random() * (base / 2);
    this.retry++;
    this.set({ conn: 'offline' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.pingTimer = setInterval(() => {
      this.sendRaw({ type: 'ping' });
      this.pongTimer ??= setTimeout(() => this.ws?.close(4100, 'pong timeout'), PONG_TIMEOUT_MS);
    }, PING_MS);
  }
  private clearHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
  }

  private sendRaw(frame: ClientFrame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.snap.conn !== 'online') {
      // auth frame is the only one allowed pre-ready, and it's sent directly in onopen
      return false;
    }
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  // ------------------------------------------------------------ inbound

  private async onFrame(raw: string) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ServerFrame.safeParse(json);
    if (!parsed.success) return;
    const f = parsed.data;
    const db = await getDb();

    switch (f.type) {
      case 'ready':
        this.retry = 0;
        this.set({ conn: 'online' });
        this.startHeartbeat();
        await this.flushOutbox();
        return;
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      case 'presence':
        if (f.deviceId === this.peer.deviceId) this.set({ peerOnline: f.online, ...(f.online ? {} : { peerTyping: false }) });
        return;
      case 'accepted': {
        await db.withTransactionAsync(async () => {
          await db.runAsync('DELETE FROM outbox WHERE id = ?', f.id);
          await db.runAsync("UPDATE messages SET status = 'sent' WHERE id = ? AND status = 'pending'", f.id);
        });
        return this.bump();
      }
      case 'delivered': {
        const ph = f.ids.map(() => '?').join(',');
        await db.runAsync(
          `UPDATE messages SET status = 'delivered' WHERE outgoing = 1 AND status IN ('pending','sent') AND id IN (${ph})`,
          f.ids,
        );
        return this.bump();
      }
      case 'error':
        console.warn('server error', f.code, f.message);
        if (f.id && f.code !== 'rate_limited') {
          await db.runAsync("UPDATE messages SET status = 'failed' WHERE id = ? AND outgoing = 1", f.id);
          await db.runAsync('DELETE FROM outbox WHERE id = ?', f.id);
          this.bump();
        }
        return;
      case 'message':
        return this.onMessage(f);
    }
  }

  private async onMessage(f: Extract<ServerFrame, { type: 'message' }>) {
    const ack = () => !f.ephemeral && this.sendRaw({ type: 'ack', ids: [f.id] });
    if (f.from !== this.peer.deviceId) return ack();

    let inner;
    try {
      inner = open(sodium, this.keys, f.id, f.payload);
    } catch (e) {
      // Undecryptable = forged/corrupt. Drop it so it isn't redelivered forever.
      if (e instanceof DecryptError) console.warn('dropping undecryptable message', e.message);
      return ack();
    }

    const db = await getDb();
    const p = inner.p;
    switch (p.k) {
      case 'typing':
        if (this.typingTimer) clearTimeout(this.typingTimer);
        this.set({ peerTyping: p.on });
        if (p.on) this.typingTimer = setTimeout(() => this.set({ peerTyping: false }), TYPING_TTL_MS);
        return;
      case 'read': {
        const ph = p.ids.map(() => '?').join(',');
        await db.runAsync(`UPDATE messages SET status = 'read' WHERE outgoing = 1 AND id IN (${ph})`, p.ids);
        break;
      }
      case 'text':
        await db.runAsync(
          "INSERT OR IGNORE INTO messages (id, outgoing, kind, body, ts, status) VALUES (?, 0, 'text', ?, ?, 'received')",
          inner.id,
          p.body,
          inner.ts,
        );
        this.set({ peerTyping: false });
        break;
      case 'image':
      case 'audio':
        await db.runAsync(
          "INSERT OR IGNORE INTO messages (id, outgoing, kind, body, media, ts, status) VALUES (?, 0, ?, ?, ?, ?, 'received')",
          inner.id,
          p.k,
          p.k === 'image' ? (p.caption ?? null) : null,
          JSON.stringify(p.media),
          inner.ts,
        );
        void this.download(inner.id, p.media);
        this.set({ peerTyping: false });
        break;
    }
    ack(); // only after it's durably stored
    this.bump();
  }

  private async download(id: string, ref: MediaRef) {
    if (this.downloading.has(id)) return;
    this.downloading.add(id);
    const db = await getDb();
    try {
      const ct = await this.api.downloadBlob(ref.blobId);
      const plain = openBlob(sodium, ct, ref);
      const uri = saveMedia(id, ref.mime, plain);
      await db.runAsync('UPDATE messages SET local_uri = ? WHERE id = ?', uri, id);
      this.bump();
      await this.api.deleteBlob(ref.blobId).catch(() => {}); // server copy no longer needed
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        await db.runAsync("UPDATE messages SET status = 'expired' WHERE id = ?", id);
        this.bump();
      } else {
        console.warn('media download failed; will retry', e);
      }
    } finally {
      this.downloading.delete(id);
    }
  }

  private async resumeDownloads() {
    const db = await getDb();
    const rows = await db.getAllAsync<MessageRow>(
      "SELECT * FROM messages WHERE outgoing = 0 AND media IS NOT NULL AND local_uri IS NULL AND status != 'expired'",
    );
    for (const r of rows) {
      const m = toMessage(r);
      if (m.media) void this.download(m.id, m.media);
    }
  }

  retryDownload(m: Message) {
    if (m.media && !m.outgoing) void this.download(m.id, m.media);
  }

  // ------------------------------------------------------------ outbound

  private async flushOutbox() {
    const db = await getDb();
    const rows = await db.getAllAsync<{ frame: string }>('SELECT frame FROM outbox ORDER BY created_at');
    for (const r of rows) if (!this.sendRaw(JSON.parse(r.frame) as SendFrame)) break;
  }

  private sealFrame(id: string, payload: InnerPayload): SendFrame {
    return { type: 'send', id, to: this.peer.deviceId, ephemeral: false, payload: seal(sodium, this.keys, id, payload) };
  }

  /** Sealed once and persisted, so retries resend identical bytes (server dedupes by id). */
  private async enqueue(frame: SendFrame) {
    const db = await getDb();
    await db.runAsync('INSERT OR REPLACE INTO outbox (id, frame, created_at) VALUES (?, ?, ?)', frame.id, JSON.stringify(frame), Date.now());
    this.sendRaw(frame);
  }

  async sendText(text: string) {
    const body = text.trim();
    if (!body) return;
    if (body.length > LIMITS.maxTextChars) throw new Error(`Message too long (max ${LIMITS.maxTextChars} chars)`);
    const id = Crypto.randomUUID();
    const ts = Date.now();
    const db = await getDb();
    await db.runAsync(
      "INSERT INTO messages (id, outgoing, kind, body, ts, status) VALUES (?, 1, 'text', ?, ?, 'pending')",
      id,
      body,
      ts,
    );
    this.bump();
    await this.enqueue(this.sealFrame(id, { k: 'text', body }));
    this.setTyping(false);
  }

  async sendImage(src: { uri: string; width: number; height: number }) {
    const img = await prepareImage(src.uri, src.width, src.height);
    const bytes = await readBytes(img.uri);
    deleteFile(img.uri);
    await this.sendMedia('image', bytes, 'image/jpeg', { width: img.width, height: img.height });
  }

  async sendAudio(uri: string, durationMs: number) {
    const bytes = await readBytes(uri);
    deleteFile(uri);
    await this.sendMedia('audio', bytes, 'audio/mp4', { durationMs: Math.round(durationMs) });
  }

  private async sendMedia(
    kind: 'image' | 'audio',
    bytes: Uint8Array,
    mime: string,
    extra: Pick<MediaRef, 'width' | 'height' | 'durationMs'>,
  ) {
    const id = Crypto.randomUUID();
    const localUri = saveMedia(id, mime, bytes);
    const db = await getDb();
    await db.runAsync(
      'INSERT INTO messages (id, outgoing, kind, local_uri, ts, status) VALUES (?, 1, ?, ?, ?, ?)',
      id,
      kind,
      localUri,
      Date.now(),
      'pending',
    );
    this.bump();
    await this.uploadAndSend(id, kind, bytes, mime, extra);
  }

  private async uploadAndSend(
    id: string,
    kind: 'image' | 'audio',
    bytes: Uint8Array,
    mime: string,
    extra: Pick<MediaRef, 'width' | 'height' | 'durationMs'>,
  ) {
    const db = await getDb();
    try {
      const blob = sealBlob(sodium, bytes);
      const blobId = await this.api.uploadBlob(blob.ciphertext);
      const media: MediaRef = { blobId, key: blob.key, nonce: blob.nonce, mime, size: bytes.byteLength, ...stripUndef(extra) };
      await db.runAsync("UPDATE messages SET media = ?, status = 'pending' WHERE id = ?", JSON.stringify(media), id);
      await this.enqueue(this.sealFrame(id, kind === 'image' ? { k: 'image', media } : { k: 'audio', media }));
    } catch (e) {
      console.warn('media upload failed', e);
      await db.runAsync("UPDATE messages SET status = 'failed' WHERE id = ?", id);
    }
    this.bump();
  }

  /** Retry a failed outgoing message. */
  async retrySend(m: Message) {
    if (!m.outgoing || m.status !== 'failed') return;
    const db = await getDb();
    if (m.kind === 'text' && m.body) {
      await db.runAsync("UPDATE messages SET status = 'pending' WHERE id = ?", m.id);
      this.bump();
      return this.enqueue(this.sealFrame(m.id, { k: 'text', body: m.body }));
    }
    if (m.local_uri && (m.kind === 'image' || m.kind === 'audio')) {
      await db.runAsync("UPDATE messages SET status = 'pending' WHERE id = ?", m.id);
      this.bump();
      const bytes = await readBytes(m.local_uri);
      const mime = m.kind === 'image' ? 'image/jpeg' : 'audio/mp4';
      return this.uploadAndSend(m.id, m.kind, bytes, mime, m.media ?? {});
    }
  }

  /** Sends read receipts for everything received so far. Call while the chat is visible. */
  async markRead() {
    const db = await getDb();
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM messages WHERE outgoing = 0 AND read_sent = 0 ORDER BY seq LIMIT ${LIMITS.maxAckBatch}`,
    );
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    await db.runAsync(
      `UPDATE messages SET read_sent = 1, status = CASE WHEN status = 'received' THEN 'read' ELSE status END WHERE id IN (${ph})`,
      ids,
    );
    await this.enqueue({ ...this.sealFrame(Crypto.randomUUID(), { k: 'read', ids }), silent: true });
  }

  private lastTypingSent = 0;
  private typingOn = false;
  /** Throttled, ephemeral typing signal; never stored server-side. */
  setTyping(on: boolean) {
    const now = Date.now();
    if (on && this.typingOn && now - this.lastTypingSent < 3000) return;
    if (!on && !this.typingOn) return;
    this.typingOn = on;
    this.lastTypingSent = now;
    const id = Crypto.randomUUID();
    this.sendRaw({ ...this.sealFrame(id, { k: 'typing', on }), ephemeral: true });
  }

  async loadMessages(limit: number): Promise<Message[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<MessageRow>('SELECT * FROM messages ORDER BY seq DESC LIMIT ?', limit);
    return rows.map(toMessage);
  }
}

function stripUndef<T extends object>(o: T): { [K in keyof T]-?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}
