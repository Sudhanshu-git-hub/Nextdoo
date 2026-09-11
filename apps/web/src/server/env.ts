import { z } from 'zod';

/**
 * Environment configuration, validated once at boot.
 * Fail fast: a missing secret must crash startup, never degrade silently.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  /** 32+ byte secret used to derive session and encryption keys. */
  AUTH_SECRET: z.string().min(32),
  APP_URL: z.string().url().default('http://localhost:3000'),
  REDIS_URL: z.string().optional(),
  /** Google Calendar OAuth (optional in dev; the feature is gated on presence). */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Stripe (optional in dev; billing falls back to a local stub). */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** S3-compatible object storage. */
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Attachment file data root (default: ./var/attachments; durable local store). */
  ATTACHMENT_STORAGE_DIR: z.string().optional(),
  /** ClamAV `clamscan` binary for attachment malware scanning (default: clamscan). */
  ATTACHMENT_SCAN_BIN: z.string().optional(),
  /** SMTP transport for the durable worker. Missing production transport fails closed. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('NEXTDOO <no-reply@nextdoo.local>'),
  /** Log level for structured output. */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    APP_URL: process.env.APP_URL,
    REDIS_URL: process.env.REDIS_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    ATTACHMENT_STORAGE_DIR: process.env.ATTACHMENT_STORAGE_DIR,
    ATTACHMENT_SCAN_BIN: process.env.ATTACHMENT_SCAN_BIN,
    SMTP_URL: process.env.SMTP_URL,
    MAIL_FROM: process.env.MAIL_FROM,
    LOG_LEVEL: process.env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** Feature availability derived from configuration, so the UI can degrade honestly. */
export function features() {
  const env = getEnv();
  return {
    googleCalendar: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    billing: Boolean(env.STRIPE_SECRET_KEY),
    // Attachments run on the durable local store by default; managed object
    // storage (S3) is the documented operational switching point. Scanner
    // availability is a runtime health dimension, not a feature gate —
    // downloads fail closed on scan status either way.
    attachments: true,
    redis: Boolean(env.REDIS_URL),
    email: Boolean(env.SMTP_URL),
  };
}
