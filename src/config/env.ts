import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the app reads, validated once at boot.
 * A bad config should crash the process here, not surface as a mystery 500 later.
 */
const int = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET must be at least 16 characters'),
  IP_HASH_SALT: z.string().min(8).default('must-chatbot-dev-salt'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  AGENT_MODE: z.enum(['mock', 'http', 'http-stream']).default('mock'),
  // Base URL only, e.g. "https://must-agent.example.com" — the agent's own
  // endpoints (/chat, /session/{id}) are appended by src/agent/httpAgent.ts.
  AGENT_BASE_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, ''))
    .optional(),
  AGENT_API_KEY: z.string().optional(),
  AGENT_TIMEOUT_MS: int(120_000),
  AGENT_FAKE_CHUNK_CHARS: int(40),
  AGENT_FAKE_CHUNK_DELAY_MS: z.coerce.number().int().min(0).default(25),

  MAX_MESSAGE_CHARS: int(8_000),
  MAX_MESSAGES_PER_CONVERSATION: int(200),

  STREAM_TTL_SECONDS: int(3_600),
  SSE_HEARTBEAT_MS: int(15_000),

  RATE_LIMIT_MESSAGES_PER_MINUTE: int(12),
  RATE_LIMIT_CONVERSATIONS_PER_HOUR: int(30),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const raw = parsed.data;

// The HTTP agent modes are useless without a base URL; catch that at boot too.
if (raw.AGENT_MODE !== 'mock' && !raw.AGENT_BASE_URL) {
  // eslint-disable-next-line no-console
  console.error(`AGENT_MODE="${raw.AGENT_MODE}" requires AGENT_BASE_URL to be set.`);
  process.exit(1);
}

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type Env = typeof env;
