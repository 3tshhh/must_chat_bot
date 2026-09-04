import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { env } from '../config/env.js';
import { redis } from '../redis/client.js';

/**
 * Redis-backed so the limit is shared across instances rather than per-process.
 * Keyed on the anonymous visitor, falling back to IP before the session exists.
 */
function make(prefix: string, windowMs: number, limit: number): ReturnType<typeof rateLimit> {
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
