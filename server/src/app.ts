import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import {
  ChallengeReq,
  LIMITS,
  PushTokenReq,
  RegisterReq,
  VerifyReq,
  fromB64,
  toB64,
} from '@pvtchat/protocol';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import { Auth, secretsEqual } from './auth.ts';
import type { Config } from './config.ts';
import { openDb, type DB } from './db.ts';
import { Hub } from './hub.ts';
import { ExpoPush, noopPush, type PushSender } from './push.ts';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string;
  }
}

export interface AppDeps {
  db?: DB;
  push?: PushSender;
}

export interface App {
  fastify: FastifyInstance;
  db: DB;
  hub: Hub;
  purge(): Promise<void>;
}

const BLOB_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const fastify = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 16 * 1024,
    disableRequestLogging: true, // don't retain IPs/timing metadata in logs
  });
  const db = deps.db ?? openDb(config.DATA_DIR);
  const blobDir = join(config.DATA_DIR, 'blobs');
  await mkdir(blobDir, { recursive: true });

  const auth = new Auth(db, config.SESSION_TTL_HOURS * 3600_000);
  const push = deps.push ?? (config.PUSH_ENABLED ? new ExpoPush(db, fastify.log) : noopPush);
  const hub = new Hub(db, auth, push, fastify.log);

  await fastify.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await fastify.register(websocket, { options: { maxPayload: 128 * 1024 } });

  // Raw streaming body for blob uploads; size enforced manually while streaming.
  fastify.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  const parse = <S extends z.ZodType>(schema: S, body: unknown, reply: FastifyReply): z.infer<S> | undefined => {
    const r = schema.safeParse(body);
    if (r.success) return r.data;
    void reply.code(400).send({ error: 'bad_request', message: r.error.issues[0]?.message ?? 'invalid body' });
    return undefined;
  };

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const deviceId = auth.resolve(h?.startsWith('Bearer ') ? h.slice(7) : undefined);
    if (!deviceId) return reply.code(401).send({ error: 'unauthorized' });
    req.deviceId = deviceId;
  };

  fastify.get('/health', async () => ({ ok: true }));

  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  fastify.post('/v1/register', strict, async (req, reply) => {
    const body = parse(RegisterReq, req.body, reply);
    if (!body) return;
    if (!secretsEqual(body.registrationSecret, config.REGISTRATION_SECRET)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const signPk = Buffer.from(fromB64(body.signPk));
    const deviceId = toB64(randomBytes(16));
    const result = db.transaction(() => {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number };
      if (n >= config.MAX_DEVICES) return 'full' as const;
      if (db.prepare('SELECT 1 FROM devices WHERE sign_pk = ?').get(signPk)) return 'exists' as const;
      db.prepare('INSERT INTO devices (id, sign_pk, name, created_at) VALUES (?, ?, ?, ?)').run(
        deviceId,
        signPk,
        body.name,
        Date.now(),
      );
      return 'ok' as const;
    })();
    if (result === 'full') return reply.code(409).send({ error: 'registration_closed' });
    if (result === 'exists') return reply.code(409).send({ error: 'already_registered' });
    req.log.info({ deviceId }, 'device registered');
    return reply.code(201).send({ deviceId });
  });

  fastify.post('/v1/auth/challenge', strict, async (req, reply) => {
    const body = parse(ChallengeReq, req.body, reply);
    if (!body) return;
    const nonce = auth.issueChallenge(body.deviceId);
    if (!nonce) return reply.code(404).send({ error: 'unknown_device' });
    return { nonce };
  });

  fastify.post('/v1/auth/verify', strict, async (req, reply) => {
    const body = parse(VerifyReq, req.body, reply);
    if (!body) return;
    const session = auth.verifyChallenge(body.deviceId, body.nonce, body.signature);
    if (!session) return reply.code(401).send({ error: 'invalid_signature' });
    return session;
  });

  fastify.register(async (authed) => {
    authed.addHook('preHandler', requireAuth);

    authed.put('/v1/push-token', async (req, reply) => {
      const body = parse(PushTokenReq, req.body, reply);
      if (!body) return;
      db.prepare('UPDATE devices SET push_token = ? WHERE id = ?').run(body.token, req.deviceId);
      return reply.code(204).send();
    });

    authed.post('/v1/blobs', { bodyLimit: LIMITS.maxBlobBytes + 1024 }, async (req, reply) => {
      const declared = Number(req.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > LIMITS.maxBlobBytes) {
        return reply.code(413).send({ error: 'too_large' });
      }
      const blobId = toB64(randomBytes(16));
      const path = join(blobDir, blobId);
      let size = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > LIMITS.maxBlobBytes) cb(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(req.body as NodeJS.ReadableStream, limiter, createWriteStream(path, { flags: 'wx' }));
      } catch (err) {
        await rm(path, { force: true });
        if ((err as { code?: string }).code === 'TOO_LARGE') return reply.code(413).send({ error: 'too_large' });
        throw err;
      }
      if (size === 0) {
        await rm(path, { force: true });
        return reply.code(400).send({ error: 'empty_body' });
      }
      db.prepare('INSERT INTO blobs (id, uploader, size, created_at) VALUES (?, ?, ?, ?)').run(
        blobId,
        req.deviceId,
        size,
        Date.now(),
      );
      return reply.code(201).send({ blobId });
    });

    authed.get<{ Params: { id: string } }>('/v1/blobs/:id', async (req, reply) => {
      const { id } = req.params;
      if (!BLOB_ID_RE.test(id) || !db.prepare('SELECT 1 FROM blobs WHERE id = ?').get(id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const path = join(blobDir, id);
      const { size } = await stat(path);
      return reply
        .type('application/octet-stream')
        .header('content-length', size)
        .header('cache-control', 'no-store')
        .send(createReadStream(path));
    });

    /** Recipient deletes after successful download + decrypt. */
    authed.delete<{ Params: { id: string } }>('/v1/blobs/:id', async (req, reply) => {
      const { id } = req.params;
      if (!BLOB_ID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
      const res = db.prepare('DELETE FROM blobs WHERE id = ? AND uploader != ?').run(id, req.deviceId);
      if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
      await rm(join(blobDir, id), { force: true });
      return reply.code(204).send();
    });
  });

  fastify.get('/v1/ws', { websocket: true }, (socket) => hub.attach(socket));

  const purge = async () => {
    auth.purgeExpired();
    const cutoff = Date.now() - config.RETENTION_DAYS * 86400_000;
    db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
    const stale = db.prepare('SELECT id FROM blobs WHERE created_at < ?').all(cutoff) as { id: string }[];
    for (const { id } of stale) {
      await rm(join(blobDir, id), { force: true });
      db.prepare('DELETE FROM blobs WHERE id = ?').run(id);
    }
  };

  fastify.addHook('onClose', async () => {
    hub.closeAll();
    if (!deps.db) db.close();
  });

  return { fastify, db, hub, purge };
}
