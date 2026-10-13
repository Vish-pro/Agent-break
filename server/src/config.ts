import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const Env = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATA_DIR: z.string().default('./data'),
  /** Shared secret required to enroll a device. Use `openssl rand -base64 32`. */
  REGISTRATION_SECRET: z.string().min(24, 'REGISTRATION_SECRET must be at least 24 chars'),
  MAX_DEVICES: z.coerce.number().int().min(2).max(10).default(2),
  /** Undelivered ciphertext and blobs older than this are purged. */
  RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
  TRUST_PROXY: bool.default(false),
  PUSH_ENABLED: bool.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
