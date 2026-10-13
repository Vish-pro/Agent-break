import type { FastifyBaseLogger } from 'fastify';
import type { DB } from './db.ts';

export interface PushSender {
  /** Notify a device that something arrived. Never includes message content. */
  notify(deviceId: string): void;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MIN_INTERVAL_MS = 15_000; // collapse bursts into one notification

/**
 * Content-free push via Expo's push service (which fronts FCM/APNs).
 * The payload is a fixed string: Expo/Google/Apple learn only "a push happened".
 */
export class ExpoPush implements PushSender {
  private readonly lastSent = new Map<string, number>();

  private readonly db: DB;
  private readonly log: FastifyBaseLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(db: DB, log: FastifyBaseLogger, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.log = log;
    this.fetchImpl = fetchImpl;
  }

  notify(deviceId: string): void {
    const row = this.db.prepare('SELECT push_token FROM devices WHERE id = ?').get(deviceId) as
      | { push_token: string | null }
      | undefined;
    const token = row?.push_token;
    if (!token) return;

    const now = Date.now();
    if (now - (this.lastSent.get(deviceId) ?? 0) < MIN_INTERVAL_MS) return;
    this.lastSent.set(deviceId, now);

    void this.send(deviceId, token);
  }

  private async send(deviceId: string, token: string): Promise<void> {
    try {
      const res = await this.fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify([
          { to: token, title: '💌', body: 'New message', sound: 'default', priority: 'high', collapseId: 'pvtchat' },
        ]),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => null)) as
        | { data?: Array<{ status: string; details?: { error?: string } }> }
        | null;
      const ticket = body?.data?.[0];
      if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        this.db.prepare('UPDATE devices SET push_token = NULL WHERE id = ? AND push_token = ?').run(deviceId, token);
        this.log.info({ deviceId }, 'push token unregistered; cleared');
      } else if (!res.ok || ticket?.status === 'error') {
        this.log.warn({ deviceId, status: res.status, ticket }, 'push send failed');
      }
    } catch (err) {
      this.log.warn({ deviceId, err }, 'push send error');
    }
  }
}

export const noopPush: PushSender = { notify() {} };
