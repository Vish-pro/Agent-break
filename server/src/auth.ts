import { authSigningInput, fromB64, toB64 } from '@pvtchat/protocol';
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { DB, DeviceRow } from './db.ts';

// DER SubjectPublicKeyInfo header for a raw 32-byte Ed25519 key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function secretsEqual(a: string, b: string): boolean {
  // Hash first so lengths match and timingSafeEqual doesn't leak length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

const CHALLENGE_TTL_MS = 60_000;
const MAX_PENDING_CHALLENGES = 256;

export class Auth {
  private readonly challenges = new Map<string, { deviceId: string; expiresAt: number }>();

  private readonly db: DB;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(db: DB, sessionTtlMs: number, now: () => number = Date.now) {
    this.db = db;
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
  }

  issueChallenge(deviceId: string): string | null {
    if (!this.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId)) return null;
    this.pruneChallenges();
    if (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      // Evict the oldest; Map preserves insertion order.
      const oldest = this.challenges.keys().next().value;
      if (oldest !== undefined) this.challenges.delete(oldest);
    }
    const nonce = toB64(randomBytes(32));
    this.challenges.set(nonce, { deviceId, expiresAt: this.now() + CHALLENGE_TTL_MS });
    return nonce;
  }

  /** Single-use challenge verification. Returns a bearer token on success. */
  verifyChallenge(deviceId: string, nonce: string, signatureB64: string): { token: string; expiresAt: number } | null {
    const pending = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (!pending || pending.deviceId !== deviceId || pending.expiresAt < this.now()) return null;

    const device = this.db.prepare('SELECT sign_pk FROM devices WHERE id = ?').get(deviceId) as
      | Pick<DeviceRow, 'sign_pk'>
      | undefined;
    if (!device) return null;

    let sig: Uint8Array;
    try {
      sig = fromB64(signatureB64);
    } catch {
      return null;
    }
    const msg = Buffer.from(authSigningInput(deviceId, nonce), 'utf8');
    if (!verifyEd25519(device.sign_pk, msg, sig)) return null;

    const token = toB64(randomBytes(32));
    const expiresAt = this.now() + this.sessionTtlMs;
    this.db
      .prepare('INSERT INTO sessions (token_hash, device_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), deviceId, expiresAt);
    return { token, expiresAt };
  }

  /** Resolves a bearer token to a device id, or null. */
  resolve(token: string | undefined): string | null {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT device_id, expires_at FROM sessions WHERE token_hash = ?')
      .get(sha256(token)) as { device_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at < this.now()) return null;
    return row.device_id;
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(this.now());
    this.pruneChallenges();
  }

  private pruneChallenges(): void {
    const t = this.now();
    for (const [k, v] of this.challenges) if (v.expiresAt < t) this.challenges.delete(k);
  }
}
