import { z } from 'zod';

/** base64url without padding. */
export const B64 = z.string().regex(/^[A-Za-z0-9_-]*$/, 'expected base64url');
export const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'invalid device id'); // 16 random bytes
export const MessageId = z.uuid();

export const LIMITS = {
  /** Max encrypted envelope (text/media refs/receipts). Media bytes go via blobs. */
  maxCiphertextBytes: 64 * 1024,
  maxBlobBytes: 25 * 1024 * 1024,
  maxTextChars: 8000,
  maxAckBatch: 500,
} as const;

// ---------------------------------------------------------------- HTTP

export const RegisterReq = z.object({
  registrationSecret: z.string().min(1).max(256),
  signPk: B64.length(43), // 32 bytes
  name: z.string().trim().min(1).max(40),
});
export const RegisterRes = z.object({ deviceId: DeviceId });

export const ChallengeReq = z.object({ deviceId: DeviceId });
export const ChallengeRes = z.object({ nonce: B64 });

export const VerifyReq = z.object({ deviceId: DeviceId, nonce: B64, signature: B64.length(86) }); // 64 bytes
export const VerifyRes = z.object({ token: B64, expiresAt: z.number().int() });

export const PushTokenReq = z.object({ token: z.string().max(256).nullable() });
export const BlobRes = z.object({ blobId: B64.length(22) });

/** Exact bytes a device signs to prove key possession. Domain-separated. */
export const authSigningInput = (deviceId: string, nonce: string): string =>
  `pvtchat-auth-v1\n${deviceId}\n${nonce}`;

// ---------------------------------------------------------------- WebSocket

/** Opaque to the server: crypto_box(nonce, ciphertext). */
export const SealedPayload = z.object({
  nonce: B64.length(32), // 24 bytes
  ct: B64.max(Math.ceil((LIMITS.maxCiphertextBytes * 4) / 3)),
});
export type SealedPayload = z.infer<typeof SealedPayload>;

export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: B64 }),
  z.object({
    type: z.literal('send'),
    id: MessageId,
    to: DeviceId,
    /** Ephemeral frames (typing) are relayed if online, never stored or pushed. */
    ephemeral: z.boolean(),
    payload: SealedPayload,
  }),
  z.object({ type: z.literal('ack'), ids: z.array(MessageId).min(1).max(LIMITS.maxAckBatch) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), deviceId: DeviceId }),
  z.object({
    type: z.literal('message'),
    id: MessageId,
    from: DeviceId,
    sentAt: z.number().int(),
    ephemeral: z.boolean(),
    payload: SealedPayload,
  }),
  /** Server persisted (or relayed, if ephemeral) the message. */
  z.object({ type: z.literal('accepted'), id: MessageId }),
  /** Recipient device acked the message. */
  z.object({ type: z.literal('delivered'), ids: z.array(MessageId) }),
  z.object({ type: z.literal('presence'), deviceId: DeviceId, online: z.boolean() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), id: MessageId.optional() }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// ---------------------------------------------------------------- E2EE inner payloads

export const MediaRef = z.object({
  blobId: B64.length(22),
  key: B64.length(43), // secretbox key, 32 bytes
  nonce: B64.length(32),
  mime: z.string().max(100),
  size: z.number().int().nonnegative().max(LIMITS.maxBlobBytes),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export const InnerPayload = z.discriminatedUnion('k', [
  z.object({ k: z.literal('text'), body: z.string().min(1).max(LIMITS.maxTextChars) }),
  z.object({ k: z.literal('image'), media: MediaRef, caption: z.string().max(1000).optional() }),
  z.object({ k: z.literal('audio'), media: MediaRef }),
  z.object({ k: z.literal('read'), ids: z.array(MessageId).min(1).max(LIMITS.maxAckBatch) }),
  z.object({ k: z.literal('typing'), on: z.boolean() }),
]);
export type InnerPayload = z.infer<typeof InnerPayload>;

/** What actually gets encrypted. `id` binds the ciphertext to the envelope id (anti-replay/swap). */
export const SealedInner = z.object({
  v: z.literal(1),
  id: MessageId,
  ts: z.number().int(),
  p: InnerPayload,
});
export type SealedInner = z.infer<typeof SealedInner>;

// ---------------------------------------------------------------- Pairing QR

export const PairingCode = z.object({
  v: z.literal(1),
  deviceId: DeviceId,
  name: z.string().max(40),
  signPk: B64.length(43),
  boxPk: B64.length(43),
  /** Present only on the inviter's first QR so the partner can enroll on the same server. */
  server: z.url({ protocol: /^https?$/ }).optional(),
  registrationSecret: z.string().max(256).optional(),
});
export type PairingCode = z.infer<typeof PairingCode>;
