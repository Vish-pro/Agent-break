import { decodePairing, encodePairingText, type PairingCode } from '@pvtchat/protocol';
import { describe, expect, it } from 'vitest';

const code: PairingCode = {
  v: 1,
  deviceId: 'AAAAAAAAAAAAAAAAAAAAAA',
  name: 'Priyá 💖',
  signPk: 'a'.repeat(43),
  boxPk: 'b'.repeat(43),
  server: 'https://x.trycloudflare.com',
  registrationSecret: 'secret-with-"quotes"',
};

describe('pairing text codes', () => {
  it('round-trips, including non-ASCII names and emoji', () => {
    expect(decodePairing(encodePairingText(code))).toEqual(code);
  });

  it('survives surrounding text and messenger line wrapping', () => {
    const token = encodePairingText(code);
    const wrapped = `Here is my code 👉 ${token.slice(0, 40)}\n${token.slice(40, 90)} ${token.slice(90)}\n\nthanks`;
    expect(decodePairing(wrapped)).toEqual(code);
  });

  it('still accepts raw QR JSON', () => {
    expect(decodePairing(JSON.stringify(code))).toEqual(code);
  });

  it('rejects garbage, truncation and wrong shapes', () => {
    const token = encodePairingText(code);
    expect(() => decodePairing('hello')).toThrow(/No pairing code/);
    expect(() => decodePairing(token.slice(0, -10))).toThrow();
    expect(() => decodePairing('{"v":2}')).toThrow(/Not a valid/);
  });
});
