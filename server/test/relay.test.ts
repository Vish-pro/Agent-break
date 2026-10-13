import { DecryptError, open, openBlob, safetyNumber, seal, sealBlob, toB64, fromB64 } from '@pvtchat/protocol';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, enroll, getSodium, login, post, SECRET, startServer, type Identity, type TestServer } from './helpers.ts';

let s: TestServer;
const clients: Client[] = [];
const connect = async (id: Identity) => {
  const c = await Client.connect(s, id);
  clients.push(c);
  return c;
};

beforeEach(async () => {
  s = await startServer();
});
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await s.close();
});

describe('registration', () => {
  it('rejects a wrong secret', async () => {
    const sodium = await getSodium();
    const r = await post(`${s.url}/v1/register`, {
      registrationSecret: 'nope',
      signPk: toB64(sodium.crypto_sign_keypair().publicKey),
      name: 'x',
    });
    expect(r.status).toBe(403);
  });

  it('closes after MAX_DEVICES and rejects re-registering the same key', async () => {
    const a = await enroll(s, 'A');
    const again = await post(`${s.url}/v1/register`, { registrationSecret: SECRET, signPk: toB64(a.sign.publicKey), name: 'A' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('already_registered');
    await enroll(s, 'B');
    await expect(enroll(s, 'C')).rejects.toThrow(/register 409/);
  });

  it('validates the body', async () => {
    const r = await post(`${s.url}/v1/register`, { registrationSecret: SECRET, signPk: 'short', name: '' });
    expect(r.status).toBe(400);
  });
});

describe('auth', () => {
  it('rejects a signature from the wrong key and single-uses nonces', async () => {
    const sodium = await getSodium();
    const a = await enroll(s, 'A');
    const ch = (await (await post(`${s.url}/v1/auth/challenge`, { deviceId: a.deviceId })).json()) as { nonce: string };
    const wrong = sodium.crypto_sign_keypair();
    const bad = toB64(sodium.crypto_sign_detached(sodium.from_string(`pvtchat-auth-v1\n${a.deviceId}\n${ch.nonce}`), wrong.privateKey));
    expect((await post(`${s.url}/v1/auth/verify`, { deviceId: a.deviceId, nonce: ch.nonce, signature: bad })).status).toBe(401);
    // Nonce was consumed by the failed attempt; a correct signature on it now fails too.
    const good = toB64(sodium.crypto_sign_detached(sodium.from_string(`pvtchat-auth-v1\n${a.deviceId}\n${ch.nonce}`), a.sign.privateKey));
    expect((await post(`${s.url}/v1/auth/verify`, { deviceId: a.deviceId, nonce: ch.nonce, signature: good })).status).toBe(401);
  });

  it('404s challenges for unknown devices', async () => {
    const r = await post(`${s.url}/v1/auth/challenge`, { deviceId: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(r.status).toBe(404);
  });

  it('closes sockets that send an invalid token or no auth', async () => {
    const c = new Client(s.wsUrl);
    clients.push(c);
    await new Promise((r) => c.ws.once('open', r));
    c.send({ type: 'auth', token: 'bogus' });
    expect((await c.waitClosed()).code).toBe(4001);

    const c2 = new Client(s.wsUrl);
    clients.push(c2);
    await new Promise((r) => c2.ws.once('open', r));
    c2.send({ type: 'ping' });
    expect((await c2.waitClosed()).code).toBe(4001);
  });

  it('requires a bearer token for HTTP routes', async () => {
    const r = await fetch(`${s.url}/v1/blobs/AAAAAAAAAAAAAAAAAAAAAA`);
    expect(r.status).toBe(401);
  });
});

describe('messaging', () => {
  let a: Identity, b: Identity;
  beforeEach(async () => {
    a = await enroll(s, 'A');
    b = await enroll(s, 'B');
  });

  it('relays E2EE messages live, then reports delivery on ack', async () => {
    const sodium = await getSodium();
    const ca = await connect(a);
    const cb = await connect(b);
    await ca.next('presence', (f) => f.deviceId === b.deviceId && f.online);

    const id = randomUUID();
    const payload = seal(sodium, { myBoxSk: a.box.privateKey, peerBoxPk: b.box.publicKey }, id, { k: 'text', body: 'hi ❤️' });
    ca.send({ type: 'send', id, to: b.deviceId, ephemeral: false, payload });
    await ca.next('accepted', (f) => f.id === id);

    const msg = await cb.next('message', (f) => f.id === id);
    expect(msg.from).toBe(a.deviceId);
    const inner = open(sodium, { myBoxSk: b.box.privateKey, peerBoxPk: a.box.publicKey }, msg.id, msg.payload);
    expect(inner.p).toEqual({ k: 'text', body: 'hi ❤️' });

    cb.send({ type: 'ack', ids: [id] });
    expect((await ca.next('delivered')).ids).toEqual([id]);
    expect(s.app.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(s.pushed).toEqual([]);
  });

  it('stores for offline recipients, pushes, and flushes in order on connect', async () => {
    const sodium = await getSodium();
    const ca = await connect(a);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      const payload = seal(sodium, { myBoxSk: a.box.privateKey, peerBoxPk: b.box.publicKey }, id, { k: 'text', body: `m${i}` });
      ca.send({ type: 'send', id, to: b.deviceId, ephemeral: false, payload });
      await ca.next('accepted', (f) => f.id === id);
    }
    expect(s.pushed).toEqual([b.deviceId, b.deviceId, b.deviceId]); // throttling lives in ExpoPush, not hub

    const cb = await connect(b);
    const got = [await cb.next('message'), await cb.next('message'), await cb.next('message')];
    expect(got.map((m) => m.id)).toEqual(ids);

    // Unacked messages are redelivered on reconnect.
    cb.close();
    await cb.waitClosed();
    const cb2 = await connect(b);
    await cb2.next('message', (f) => f.id === ids[0]);
    cb2.send({ type: 'ack', ids });
    await ca.next('delivered');
  });

  it('never stores or pushes ephemeral frames', async () => {
    const sodium = await getSodium();
    const ca = await connect(a);
    const id = randomUUID();
    const payload = seal(sodium, { myBoxSk: a.box.privateKey, peerBoxPk: b.box.publicKey }, id, { k: 'typing', on: true });
    ca.send({ type: 'send', id, to: b.deviceId, ephemeral: true, payload });
    await ca.next('accepted');
    expect(s.pushed).toEqual([]);
    expect(s.app.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('stores but does not push silent frames', async () => {
    const sodium = await getSodium();
    const ca = await connect(a);
    const id = randomUUID();
    const payload = seal(sodium, { myBoxSk: a.box.privateKey, peerBoxPk: b.box.publicKey }, id, { k: 'read', ids: [randomUUID()] });
    ca.send({ type: 'send', id, to: b.deviceId, ephemeral: false, silent: true, payload });
    await ca.next('accepted');
    expect(s.pushed).toEqual([]);
    expect(s.app.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });

  it('treats a resend of the same id as idempotent', async () => {
    const sodium = await getSodium();
    const ca = await connect(a);
    const id = randomUUID();
    const payload = seal(sodium, { myBoxSk: a.box.privateKey, peerBoxPk: b.box.publicKey }, id, { k: 'text', body: 'x' });
    ca.send({ type: 'send', id, to: b.deviceId, ephemeral: false, payload });
    await ca.next('accepted');
    ca.send({ type: 'send', id, to: b.deviceId, ephemeral: false, payload });
    await ca.next('accepted');
    expect(s.app.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });

  it('rejects unknown recipients, self-sends and malformed frames', async () => {
    const ca = await connect(a);
    const payload = { nonce: toB64(new Uint8Array(24)), ct: 'AAAA' };
    ca.send({ type: 'send', id: randomUUID(), to: 'AAAAAAAAAAAAAAAAAAAAAA', ephemeral: false, payload });
    expect((await ca.next('error')).code).toBe('unknown_recipient');
    ca.send({ type: 'send', id: randomUUID(), to: a.deviceId, ephemeral: false, payload });
    expect((await ca.next('error')).code).toBe('unknown_recipient');
    ca.send({ type: 'send', id: 'not-a-uuid', to: b.deviceId, ephemeral: false, payload });
    expect((await ca.next('error')).code).toBe('bad_frame');
    ca.ws.send('{oops');
    expect((await ca.next('error')).code).toBe('bad_json');
  });

  it('only lets the recipient ack a message', async () => {
    const sodium = await getSodium();
    const ca = await connect(a);
    const id = randomUUID();
    const payload = seal(sodium, { myBoxSk: a.box.privateKey, peerBoxPk: b.box.publicKey }, id, { k: 'text', body: 'x' });
    ca.send({ type: 'send', id, to: b.deviceId, ephemeral: false, payload });
    await ca.next('accepted');
    ca.send({ type: 'ack', ids: [id] });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.app.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });

  it('replaces an older connection for the same device', async () => {
    const first = await connect(a);
    const token2 = await login(s, a.deviceId, a.sign.privateKey);
    await connect({ ...a, token: token2 });
    expect((await first.waitClosed()).code).toBe(4000);
  });
});

describe('blobs', () => {
  let a: Identity, b: Identity;
  beforeEach(async () => {
    a = await enroll(s, 'A');
    b = await enroll(s, 'B');
  });

  const upload = (token: string, body: Uint8Array) =>
    fetch(`${s.url}/v1/blobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.from(body),
    });

  it('round-trips an encrypted attachment and lets only the recipient delete it', async () => {
    const sodium = await getSodium();
    const original = sodium.randombytes_buf(300_000);
    const sealed = sealBlob(sodium, original);
    const up = await upload(a.token, sealed.ciphertext);
    expect(up.status).toBe(201);
    const { blobId } = (await up.json()) as { blobId: string };

    const down = await fetch(`${s.url}/v1/blobs/${blobId}`, { headers: { authorization: `Bearer ${b.token}` } });
    expect(down.status).toBe(200);
    const ct = new Uint8Array(await down.arrayBuffer());
    expect(openBlob(sodium, ct, sealed)).toEqual(original);

    const delByUploader = await fetch(`${s.url}/v1/blobs/${blobId}`, { method: 'DELETE', headers: { authorization: `Bearer ${a.token}` } });
    expect(delByUploader.status).toBe(404);
    const del = await fetch(`${s.url}/v1/blobs/${blobId}`, { method: 'DELETE', headers: { authorization: `Bearer ${b.token}` } });
    expect(del.status).toBe(204);
    const gone = await fetch(`${s.url}/v1/blobs/${blobId}`, { headers: { authorization: `Bearer ${b.token}` } });
    expect(gone.status).toBe(404);
  });

  it('rejects oversize and empty uploads', async () => {
    expect((await upload(a.token, new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(a.token, new Uint8Array(0))).status).toBe(400);
  });

  it('rejects path traversal ids', async () => {
    const r = await fetch(`${s.url}/v1/blobs/..%2F..%2Frelay.sqlite`, { headers: { authorization: `Bearer ${a.token}` } });
    expect(r.status).toBe(404);
  });

  it('purges blobs and messages past retention', async () => {
    const up = await upload(a.token, new Uint8Array([1, 2, 3]));
    const { blobId } = (await up.json()) as { blobId: string };
    s.app.db.prepare('UPDATE blobs SET created_at = 0').run();
    await s.app.purge();
    const r = await fetch(`${s.url}/v1/blobs/${blobId}`, { headers: { authorization: `Bearer ${b.token}` } });
    expect(r.status).toBe(404);
  });
});

describe('protocol crypto', () => {
  it('rejects tampering, wrong keys and envelope id swaps', async () => {
    const sodium = await getSodium();
    const a = sodium.crypto_box_keypair();
    const b = sodium.crypto_box_keypair();
    const eve = sodium.crypto_box_keypair();
    const id = randomUUID();
    const sealed = seal(sodium, { myBoxSk: a.privateKey, peerBoxPk: b.publicKey }, id, { k: 'text', body: 'secret' });
    const bk = { myBoxSk: b.privateKey, peerBoxPk: a.publicKey };

    expect(() => open(sodium, bk, randomUUID(), sealed)).toThrow(/envelope id mismatch/);
    expect(() => open(sodium, { myBoxSk: b.privateKey, peerBoxPk: eve.publicKey }, id, sealed)).toThrow(DecryptError);
    const ct = fromB64(sealed.ct);
    ct[0] = ct[0]! ^ 1;
    expect(() => open(sodium, bk, id, { ...sealed, ct: toB64(ct) })).toThrow(DecryptError);
  });

  it('produces an order-independent safety number', async () => {
    const sodium = await getSodium();
    const x = { signPk: 'a'.repeat(43), boxPk: 'b'.repeat(43) };
    const y = { signPk: 'c'.repeat(43), boxPk: 'd'.repeat(43) };
    expect(safetyNumber(sodium, x, y)).toBe(safetyNumber(sodium, y, x));
    expect(safetyNumber(sodium, x, y)).toMatch(/^(\d{5} ){5}\d{5}$/);
  });

  it('base64url round-trips all lengths', async () => {
    const sodium = await getSodium();
    for (let n = 0; n < 70; n++) {
      const b = sodium.randombytes_buf(n);
      expect(fromB64(toB64(b))).toEqual(b);
      expect(toB64(b)).toBe(Buffer.from(b).toString('base64url'));
    }
  });
});
