import {
  BlobRes,
  ChallengeRes,
  LIMITS,
  RegisterRes,
  VerifyRes,
  authSigningInput,
  fromB64,
  toB64,
} from '@pvtchat/protocol';
import type { z } from 'zod';
import type { Identity } from './secrets';
import { sodium } from './sodium';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

const TIMEOUT_MS = 20_000;

export function normalizeServer(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' && !/^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname)) {
    throw new Error('Server must use https:// (http allowed only for LAN testing)');
  }
  return url.origin;
}

type ReqInit = RequestInit & { token?: string | undefined };

async function request<S extends z.ZodType>(server: string, path: string, init: ReqInit & { schema: S }): Promise<z.infer<S>>;
async function request(server: string, path: string, init: ReqInit): Promise<void>;
async function request(server: string, path: string, init: ReqInit & { schema?: z.ZodType }): Promise<unknown> {
  const { schema, token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (rest.body && typeof rest.body === 'string') headers.set('content-type', 'application/json');
  const res = await fetch(server + path, { ...rest, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? 'http_error');
  }
  return schema ? schema.parse(await res.json()) : undefined;
}

export async function register(server: string, registrationSecret: string, signPk: string, name: string) {
  return request(server, '/v1/register', {
    method: 'POST',
    body: JSON.stringify({ registrationSecret, signPk, name }),
    schema: RegisterRes,
  });
}

/** Authenticated client: signs a fresh challenge whenever it needs a token. */
export class Api {
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  readonly me: Identity;

  constructor(me: Identity) {
    this.me = me;
  }

  get server() {
    return this.me.server;
  }

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - Date.now() > 60_000) return this.token.value;
    this.inflight ??= this.login().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async login(): Promise<string> {
    const { deviceId, signSk } = this.me;
    const { nonce } = await request(this.server, '/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
      schema: ChallengeRes,
    });
    const signature = toB64(sodium.crypto_sign_detached(authSigningInput(deviceId, nonce), fromB64(signSk)));
    const session = await request(this.server, '/v1/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ deviceId, nonce, signature }),
      schema: VerifyRes,
    });
    this.token = { value: session.token, expiresAt: session.expiresAt };
    return session.token;
  }

  /** Runs `fn` with a token, re-authenticating once on 401. */
  private async authed<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.getToken());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return fn(await this.getToken(true));
      throw e;
    }
  }

  setPushToken(token: string | null) {
    return this.authed((t) =>
      request(this.server, '/v1/push-token', { method: 'PUT', body: JSON.stringify({ token }), token: t }),
    );
  }

  uploadBlob(ciphertext: Uint8Array): Promise<string> {
    if (ciphertext.byteLength > LIMITS.maxBlobBytes) throw new Error('Attachment too large (max 25 MB)');
    return this.authed(async (t) => {
      const { blobId } = await request(this.server, '/v1/blobs', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: ciphertext as unknown as BodyInit,
        token: t,
        schema: BlobRes,
      });
      return blobId;
    });
  }

  downloadBlob(blobId: string): Promise<Uint8Array> {
    return this.authed(async (t) => {
      const res = await fetch(`${this.server}/v1/blobs/${encodeURIComponent(blobId)}`, {
        headers: { authorization: `Bearer ${t}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new ApiError(res.status, 'blob_download_failed');
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  deleteBlob(blobId: string) {
    return this.authed((t) =>
      request(this.server, `/v1/blobs/${encodeURIComponent(blobId)}`, { method: 'DELETE', token: t }),
    );
  }

  wsUrl(): string {
    return this.server.replace(/^http/, 'ws') + '/v1/ws';
  }
}
