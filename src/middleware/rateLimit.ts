import rateLimitImport, {
  type Options,
  type RateLimitRequestHandler,
  type Store,
} from 'express-rate-limit';
import RedisStoreImport, {
  type Options as RedisStoreOptions,
} from 'rate-limit-redis';
import { env } from '../config/env.js';
import { redis } from '../redis/client.js';

// express-rate-limit and rate-limit-redis ship dual ESM/CJS builds. Some
// TypeScript resolution setups (notably the Vercel build) bind the module
// namespace instead of the default export, so `rateLimit(...)` / `new RedisStore(...)`
// are seen as non-callable. Both are correct at runtime; normalize the types here.
const rateLimit = rateLimitImport as unknown as (
  options?: Partial<Options>,
) => RateLimitRequestHandler;
const RedisStore = RedisStoreImport as unknown as new (
  options: Partial<RedisStoreOptions>,
) => Store;

/**
 * Redis-backed so the limit is shared across instances rather than per-process.
 * Keyed on the anonymous visitor, falling back to IP before the session exists.
 */
function make(prefix: string, windowMs: number, limit: number): RateLimitRequestHandler {
  const options: Partial<Options> = {
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.visitorId ?? req.ip ?? 'unknown',
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as any,
    }),
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' },
      });
    },
    // Tests would otherwise trip over their own fixtures.
    skip: () => env.isTest,
  };
  return rateLimit(options);
}

export const messageRateLimit = make('msg', 60_000, env.RATE_LIMIT_MESSAGES_PER_MINUTE);
export const conversationRateLimit = make(
  'conv',
  60 * 60_000,
  env.RATE_LIMIT_CONVERSATIONS_PER_HOUR,
);
