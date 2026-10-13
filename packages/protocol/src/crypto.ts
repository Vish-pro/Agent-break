import { fromB64, toB64 } from './base64.ts';
import { SealedInner, type InnerPayload, type MediaRef, type SealedPayload } from './schemas.ts';

/**
 * The subset of the libsodium-wrappers API we use. Satisfied by both
 * `libsodium-wrappers-sumo` (Node/tests) and `react-native-libsodium` (app).
 */
export interface Sodium {
  readonly crypto_box_NONCEBYTES: number;
  readonly crypto_secretbox_NONCEBYTES: number;
  readonly crypto_secretbox_KEYBYTES: number;
  randombytes_buf(length: number): Uint8Array;
  crypto_box_easy(message: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_box_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  crypto_secretbox_easy(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_secretbox_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  crypto_generichash(hashLength: number, message: Uint8Array): Uint8Array;
  from_string(str: string): Uint8Array;
  to_string(bytes: Uint8Array): string;
}

export interface BoxKeys {
  myBoxSk: Uint8Array;
  peerBoxPk: Uint8Array;
}

export function seal(sodium: Sodium, keys: BoxKeys, id: string, payload: InnerPayload, ts = Date.now()): SealedPayload {
  const inner: SealedInner = { v: 1, id, ts, p: payload };
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ct = sodium.crypto_box_easy(sodium.from_string(JSON.stringify(inner)), nonce, keys.peerBoxPk, keys.myBoxSk);
  return { nonce: toB64(nonce), ct: toB64(ct) };
}

export class DecryptError extends Error {}

/** Decrypts, schema-validates and checks that the inner id matches the envelope id. */
export function open(sodium: Sodium, keys: BoxKeys, envelopeId: string, sealed: SealedPayload): SealedInner {
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_box_open_easy(fromB64(sealed.ct), fromB64(sealed.nonce), keys.peerBoxPk, keys.myBoxSk);
  } catch {
    throw new DecryptError('authentication failed');
  }
  let json: unknown;
  try {
    json = JSON.parse(sodium.to_string(plain));
  } catch {
    throw new DecryptError('malformed plaintext');
  }
  const parsed = SealedInner.safeParse(json);
  if (!parsed.success) throw new DecryptError('invalid inner payload');
  if (parsed.data.id !== envelopeId) throw new DecryptError('envelope id mismatch');
  return parsed.data;
}

/** Encrypts an attachment with a fresh random key. Returns ciphertext to upload + ref (minus blobId). */
export function sealBlob(
  sodium: Sodium,
  bytes: Uint8Array,
): { ciphertext: Uint8Array; key: string; nonce: string } {
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return { ciphertext: sodium.crypto_secretbox_easy(bytes, nonce, key), key: toB64(key), nonce: toB64(nonce) };
}

export function openBlob(sodium: Sodium, ciphertext: Uint8Array, ref: Pick<MediaRef, 'key' | 'nonce'>): Uint8Array {
  try {
    return sodium.crypto_secretbox_open_easy(ciphertext, fromB64(ref.nonce), fromB64(ref.key));
  } catch {
    throw new DecryptError('attachment authentication failed');
  }
}

/**
 * Human-comparable safety number over both identities, order-independent.
 * Compare on both phones during pairing to rule out a swapped QR.
 */
export function safetyNumber(
  sodium: Sodium,
  a: { signPk: string; boxPk: string },
  b: { signPk: string; boxPk: string },
): string {
  const [x, y] = [a.signPk + a.boxPk, b.signPk + b.boxPk].sort();
  const digest = sodium.crypto_generichash(30, sodium.from_string(`pvtchat-safety-v1|${x}|${y}`));
  const groups: string[] = [];
  for (let i = 0; i < 30; i += 5) {
    // 5 bytes -> 40 bits -> 12 decimal digits would overflow display; use 5-digit groups mod 1e5.
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + digest[i + j]!;
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}
