import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Shared connection for ordinary commands (XADD, SET, XRANGE, ...).
 *
 * Blocking reads (XREAD BLOCK) monopolise a connection for their whole duration,
 * so every SSE reader gets its own short-lived connection from `createBlockingClient()`
 * instead of stealing this one.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (err) => logger.error({ err }, 'redis error'));

const blockingClients = new Set<Redis>();

export function createBlockingClient(): Redis {
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', (err) => logger.warn({ err }, 'redis blocking client error'));
  blockingClients.add(client);
  client.once('end', () => blockingClients.delete(client));
  return client;
}

export function releaseBlockingClient(client: Redis): void {
  blockingClients.delete(client);
  client.disconnect();
}

export async function pingRedis(): Promise<void> {
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error(`unexpected redis ping response: ${pong}`);
}

export async function disconnectRedis(): Promise<void> {
  for (const client of blockingClients) client.disconnect();
  blockingClients.clear();
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
