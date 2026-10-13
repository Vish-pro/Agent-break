import { ClientFrame, type ServerFrame } from '@pvtchat/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import type { Auth } from './auth.ts';
import type { DB, MessageRow } from './db.ts';
import type { PushSender } from './push.ts';

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
// Simple per-connection token bucket.
const RATE_CAPACITY = 60;
const RATE_REFILL_PER_SEC = 20;

type Conn = { socket: WebSocket; deviceId: string };

/** Routes sealed envelopes between authenticated device connections. */
export class Hub {
  private readonly conns = new Map<string, Conn>();
  private readonly stmts;

  private readonly db: DB;
  private readonly auth: Auth;
  private readonly push: PushSender;
  private readonly log: FastifyBaseLogger;

  constructor(db: DB, auth: Auth, push: PushSender, log: FastifyBaseLogger) {
    this.db = db;
    this.auth = auth;
    this.push = push;
    this.log = log;
    this.stmts = {
      deviceExists: db.prepare('SELECT 1 FROM devices WHERE id = ?'),
      insertMsg: db.prepare(
        'INSERT OR IGNORE INTO messages (id, sender, recipient, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      ),
      msgOwner: db.prepare('SELECT sender, recipient FROM messages WHERE id = ?'),
      pending: db.prepare('SELECT * FROM messages WHERE recipient = ? ORDER BY created_at, rowid'),
      ackSelect: db.prepare('SELECT id, sender FROM messages WHERE id = ? AND recipient = ?'),
      ackDelete: db.prepare('DELETE FROM messages WHERE id = ? AND recipient = ?'),
    };
  }

  isOnline(deviceId: string): boolean {
    return this.conns.has(deviceId);
  }

  /** Forcefully disconnect a device (e.g. after it's removed). */
  kick(deviceId: string): void {
    this.conns.get(deviceId)?.socket.close(4003, 'revoked');
  }

  attach(socket: WebSocket): void {
    let conn: Conn | null = null;
    let alive = true;
    let tokens = RATE_CAPACITY;
    let lastRefill = Date.now();

    const authTimer = setTimeout(() => {
      if (!conn) socket.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    socket.on('pong', () => (alive = true));

    socket.on('message', (raw, isBinary) => {
      const now = Date.now();
      tokens = Math.min(RATE_CAPACITY, tokens + ((now - lastRefill) / 1000) * RATE_REFILL_PER_SEC);
      lastRefill = now;
      if (tokens < 1) return send(socket, { type: 'error', code: 'rate_limited', message: 'slow down' });
      tokens -= 1;

      if (isBinary) return socket.close(1003, 'text frames only');
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: 'error', code: 'bad_json', message: 'invalid JSON' });
      }
      const parsed = ClientFrame.safeParse(json);
      if (!parsed.success) {
        return send(socket, { type: 'error', code: 'bad_frame', message: parsed.error.issues[0]?.message ?? 'invalid' });
      }
      const frame = parsed.data;

      if (!conn) {
        if (frame.type !== 'auth') return socket.close(4001, 'auth required');
        const deviceId = this.auth.resolve(frame.token);
        if (!deviceId) return socket.close(4001, 'invalid token');
        clearTimeout(authTimer);
        conn = { socket, deviceId };
        this.onAuthenticated(conn);
        return;
      }

      try {
        this.handle(conn, frame);
      } catch (err) {
        this.log.error({ err }, 'frame handling failed');
        send(socket, { type: 'error', code: 'internal', message: 'internal error' });
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (conn && this.conns.get(conn.deviceId)?.socket === socket) {
        this.conns.delete(conn.deviceId);
        this.broadcastPresence(conn.deviceId, false);
      }
    });
    socket.on('error', (err) => this.log.debug({ err }, 'socket error'));
  }

  private onAuthenticated(conn: Conn): void {
    const previous = this.conns.get(conn.deviceId);
    this.conns.set(conn.deviceId, conn);
    previous?.socket.close(4000, 'replaced by newer connection');

    send(conn.socket, { type: 'ready', deviceId: conn.deviceId });
    for (const other of this.conns.keys()) {
      if (other !== conn.deviceId) send(conn.socket, { type: 'presence', deviceId: other, online: true });
    }
    this.broadcastPresence(conn.deviceId, true);
    this.flush(conn);
  }

  private flush(conn: Conn): void {
    const rows = this.stmts.pending.all(conn.deviceId) as MessageRow[];
    for (const row of rows) {
      send(conn.socket, {
        type: 'message',
        id: row.id,
        from: row.sender,
        sentAt: row.created_at,
        ephemeral: false,
        payload: JSON.parse(row.payload),
      });
    }
  }

  private handle(conn: Conn, frame: ClientFrame): void {
    switch (frame.type) {
      case 'auth':
        return send(conn.socket, { type: 'error', code: 'already_authenticated', message: 'already authenticated' });
      case 'ping':
        return send(conn.socket, { type: 'pong' });
      case 'send':
        return this.onSend(conn, frame);
      case 'ack':
        return this.onAck(conn, frame.ids);
    }
  }

  private onSend(conn: Conn, frame: Extract<ClientFrame, { type: 'send' }>): void {
    const { id, to, ephemeral, payload } = frame;
    if (to === conn.deviceId || !this.stmts.deviceExists.get(to)) {
      return send(conn.socket, { type: 'error', code: 'unknown_recipient', message: 'unknown recipient', id });
    }
    const sentAt = Date.now();
    const recipient = this.conns.get(to);

    if (!ephemeral) {
      const res = this.stmts.insertMsg.run(id, conn.deviceId, to, JSON.stringify(payload), sentAt);
      if (res.changes === 0) {
        // Same id already stored: idempotent retry from the same sender, or a collision.
        const existing = this.stmts.msgOwner.get(id) as { sender: string; recipient: string } | undefined;
        if (existing?.sender === conn.deviceId && existing.recipient === to) {
          return send(conn.socket, { type: 'accepted', id });
        }
        return send(conn.socket, { type: 'error', code: 'duplicate_id', message: 'message id in use', id });
      }
    }

    if (recipient) {
      send(recipient.socket, { type: 'message', id, from: conn.deviceId, sentAt, ephemeral, payload });
    } else if (!ephemeral) {
      this.push.notify(to);
    }
    send(conn.socket, { type: 'accepted', id });
  }

  private onAck(conn: Conn, ids: string[]): void {
    const bySender = new Map<string, string[]>();
    this.db.transaction(() => {
      for (const id of ids) {
        const row = this.stmts.ackSelect.get(id, conn.deviceId) as { id: string; sender: string } | undefined;
        if (!row) continue;
        this.stmts.ackDelete.run(id, conn.deviceId);
        const list = bySender.get(row.sender) ?? [];
        list.push(id);
        bySender.set(row.sender, list);
      }
    })();
    for (const [sender, delivered] of bySender) {
      const c = this.conns.get(sender);
      if (c) send(c.socket, { type: 'delivered', ids: delivered });
    }
  }

  private broadcastPresence(deviceId: string, online: boolean): void {
    for (const [id, c] of this.conns) {
      if (id !== deviceId) send(c.socket, { type: 'presence', deviceId, online });
    }
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.socket.close(1001, 'server shutting down');
  }
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}
