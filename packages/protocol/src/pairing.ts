import { fromB64, toB64 } from './base64.ts';
import { PairingCode } from './schemas.ts';

const PREFIX = 'justus1:';
/** Terminator: lets us tolerate inserted whitespace and detect truncated pastes. */
const SUFFIX = '.';

/** ASCII-only JSON (non-ASCII as \uXXXX) so bytes == char codes; no TextDecoder needed on Hermes. */
const asciiJson = (v: unknown) =>
  JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** Compact single-token form for sharing over messengers. */
export function encodePairingText(code: PairingCode): string {
  const json = asciiJson(code);
  const bytes = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i);
  return PREFIX + toB64(bytes) + SUFFIX;
}

export class PairingParseError extends Error {}

/**
 * Accepts a QR payload (raw JSON) or pasted text containing a `justus1:` token,
 * tolerating surrounding message text and whitespace/line breaks inserted by messengers.
 */
export function decodePairing(input: string): PairingCode {
  const trimmed = input.trim();
  let json: string;
  if (trimmed.startsWith('{')) {
    json = trimmed;
  } else {
    if (!trimmed.includes(PREFIX)) throw new PairingParseError('No pairing code found');
    const m = /justus1:([A-Za-z0-9_\-\s]+)\./.exec(trimmed);
    if (!m?.[1]) throw new PairingParseError('Pairing code is incomplete; copy the whole thing');
    let bytes: Uint8Array;
    try {
      bytes = fromB64(m[1].replace(/\s+/g, ''));
    } catch {
      throw new PairingParseError('Pairing code is damaged; copy it again');
    }
    json = String.fromCharCode(...bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PairingParseError('Pairing code is damaged; copy it again');
  }
  const r = PairingCode.safeParse(parsed);
  if (!r.success) throw new PairingParseError('Not a valid pairing code');
  return r.data;
}
