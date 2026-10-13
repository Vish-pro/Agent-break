import { authSigningInput, ServerFrame, toB64, fromB64, type Sodium } from '@pvtchat/protocol';
import _sodium from 'libsodium-wrappers-sumo';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { PushSender } from '../src/push.ts';

export const SECRET = 'test-registration-secret-0123456789';

export async function getSodium(): Promise<typeof _sodium & Sodium> {
  await _sodium.ready;
  return _sodium as typeof _sodium & Sodium;
}

export interface TestServer {
  app: App;
  url: string;
  wsUrl: string;
  pushed: string[];
  close(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'pvtchat-'));
  const pushed: string[] = [];
  const push: PushSender = { notify: (id) => pushed.push(id) };
  const config = loadConfig({ REGISTRATION_SECRET: SECRET, DATA_DIR: dir, LOG_LEVEL: 'silent', ...env });
  const app = await buildApp(config, { push });
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.fastify.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    app,
    url,
    wsUrl: `ws://127.0.0.1:${addr.port}/v1/ws`,
    pushed,
    async close() {
      await app.fastify.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Identity {
  name: string;
  deviceId: string;
  sign: { publicKey: Uint8Array; privateKey: Uint8Array };
  box: { publicKey: Uint8Array; privateKey: Uint8Array };
  token: string;
}

export async function post(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

export async function enroll(s: TestServer, name: string): Promise<Identity> {
  const sodium = await getSodium();
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  const reg = await post(`${s.url}/v1/register`, { registrationSecret: SECRET, signPk: toB64(sign.publicKey), name });
  if (reg.status !== 201) throw new Error(`register ${reg.status} ${await reg.text()}`);
  const { deviceId } = (await reg.json()) as { deviceId: string };
  const token = await login(s, deviceId, sign.privateKey);
  return { name, deviceId, sign, box, token };
}

export async function login(s: TestServer, deviceId: string, signSk: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  const ch = await post(`${s.url}/v1/auth/challenge`, { deviceId });
  const { nonce } = (await ch.json()) as { nonce: string };
  const signature = toB64(sodium.crypto_sign_detached(sodium.from_string(authSigningInput(deviceId, nonce)), signSk));
  const v = await post(`${s.url}/v1/auth/verify`, { deviceId, nonce, signature });
  if (v.status !== 200) throw new Error(`verify ${v.status}`);
  return ((await v.json()) as { token: string }).token;
}

/** A WebSocket client that buffers frames and lets tests await specific ones. */
export class Client {
  readonly ws: WebSocket;
  private readonly frames: ServerFrame[] = [];
  private waiters: Array<() => void> = [];
  closed: { code: number; reason: string } | null = null;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.on('message', (raw) => {
      this.frames.push(ServerFrame.parse(JSON.parse(raw.toString())));
      this.wake();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  static async connect(s: TestServer, id: Identity): Promise<Client> {
    const c = new Client(s.wsUrl);
    await new Promise<void>((res, rej) => {
      c.ws.once('open', () => res());
      c.ws.once('error', rej);
    });
    c.send({ type: 'auth', token: id.token });
    await c.next('ready');
    return c;
  }

  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }

  async next<T extends ServerFrame['type']>(
    type: T,
    pred: (f: Extract<ServerFrame, { type: T }>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Extract<ServerFrame, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.frames.findIndex((f) => f.type === type && pred(f as Extract<ServerFrame, { type: T }>));
      if (i >= 0) return this.frames.splice(i, 1)[0] as Extract<ServerFrame, { type: T }>;
      const left = deadline - Date.now();
      if (left <= 0 || this.closed) throw new Error(`timeout waiting for ${type}; closed=${JSON.stringify(this.closed)}`);
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  has(type: ServerFrame['type']): boolean {
    return this.frames.some((f) => f.type === type);
  }

  async waitClosed(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    if (!this.closed) throw new Error('not closed');
    return this.closed;
  }

  close() {
    this.ws.close();
  }
}

export const bytes = (b64: string) => fromB64(b64);
