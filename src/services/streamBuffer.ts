import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createBlockingClient, redis, releaseBlockingClient } from '../redis/client.js';

/**
 * Per-assistant-message token buffer, backed by a Redis Stream.
 *
 * Why a Redis Stream and not pub/sub: every entry gets a monotonic id, which we
 * hand to the browser as the SSE `id:` field. On reconnect the browser sends it
 * back as `Last-Event-ID` and we XRANGE from exactly there — no gaps, no repeats,
 * and no requirement that the reconnect lands on the instance that is generating.
 */

export type BufferEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens?: number; outputTokens?: number }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; code: string; message: string };

export interface BufferEntry {
  /** Redis stream entry id, e.g. "1738000000000-0". Doubles as the SSE event id. */
  id: string;
  event: BufferEvent;
}

/** What `follow()` emits: a real entry, or a tick meaning "nothing yet". */
export type FollowTick = { kind: 'entry'; entry: BufferEntry } | { kind: 'idle' };

const streamKey = (messageId: string) => `chat:stream:${messageId}`;
const cancelKey = (messageId: string) => `chat:cancel:${messageId}`;
const lockKey = (messageId: string) => `chat:lock:${messageId}`;

function isTerminal(event: BufferEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

/** Redis stream fields are flat string pairs, so events are stored as JSON. */
function encode(event: BufferEvent): string[] {
  return ['type', event.type, 'data', JSON.stringify(event)];
}

function decode(fields: string[]): BufferEvent | null {
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === 'data') {
      try {
        return JSON.parse(fields[i + 1]!) as BufferEvent;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const streamBuffer = {
  /** Append one event; the returned id is what a client would resume after. */
  async append(messageId: string, event: BufferEvent): Promise<string> {
    const key = streamKey(messageId);
    const id = await redis.xadd(key, '*', ...encode(event));
    if (isTerminal(event)) {
      // Keep the finished stream around briefly so a late reconnect can replay it;
      // after that, Postgres is the only copy (and the SSE route falls back to it).
      await redis.expire(key, env.STREAM_TTL_SECONDS);
    } else {
      // Refresh the TTL while generating so a long answer can't expire mid-flight.
      await redis.expire(key, env.STREAM_TTL_SECONDS);
    }
    return id!;
  },

  /** Everything already buffered after `afterId` ("0" = from the beginning). */
  async replay(messageId: string, afterId: string): Promise<BufferEntry[]> {
    const exclusive = afterId === '0' || afterId === '' ? '-' : `(${afterId}`;
    const rows = (await redis.xrange(streamKey(messageId), exclusive, '+')) as [string, string[]][];
    return rows
      .map(([id, fields]) => {
        const event = decode(fields);
        return event ? { id, event } : null;
      })
      .filter((e): e is BufferEntry => e !== null);
  },

  async exists(messageId: string): Promise<boolean> {
    return (await redis.exists(streamKey(messageId))) === 1;
  },

  /**
   * Async iterator over the buffer: replays what was missed, then blocks for new
   * entries, and returns once a terminal event is seen or `signal` aborts.
   * Uses its own connection because XREAD BLOCK ties one up.
   *
   * Yields an `idle` tick whenever the blocking read times out, which gives the
   * caller a regular chance to heartbeat and to check whether the generator it is
   * waiting on is still alive. Following a key that does not exist yet is fine —
   * XREAD picks up the entries as soon as the runner creates it.
   */
  async *follow(
    messageId: string,
    afterId: string,
    signal: AbortSignal,
  ): AsyncIterable<FollowTick> {
    let cursor = afterId === '' ? '0' : afterId;

    for (const entry of await this.replay(messageId, cursor)) {
      yield { kind: 'entry', entry };
      cursor = entry.id;
      if (isTerminal(entry.event)) return;
    }
    if (signal.aborted) return;

    let client: Redis | null = null;
    try {
      client = createBlockingClient();
      const key = streamKey(messageId);

      while (!signal.aborted) {
        // Block for at most one heartbeat interval so the SSE route can send a
        // keep-alive comment and notice a closed socket promptly.
        const res = (await client.xread(
          'BLOCK',
          env.SSE_HEARTBEAT_MS,
          'STREAMS',
          key,
          cursor,
        )) as [string, [string, string[]][]][] | null;

        if (!res) {
          yield { kind: 'idle' }; // timed out: let the caller heartbeat and re-check
          continue;
        }
        for (const [, rows] of res) {
          for (const [id, fields] of rows) {
            cursor = id;
            const event = decode(fields);
            if (!event) continue;
            yield { kind: 'entry', entry: { id, event } };
            if (isTerminal(event)) return;
          }
        }
      }
    } finally {
      if (client) releaseBlockingClient(client);
    }
  },

  async drop(messageId: string): Promise<void> {
    await redis.del(streamKey(messageId)).catch((err) => logger.warn({ err }, 'stream drop failed'));
  },

  // ---- generation lock: stops a retried POST producing two answers ----

  async acquireLock(messageId: string, ttlSeconds: number): Promise<boolean> {
    const res = await redis.set(lockKey(messageId), '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  },

  async releaseLock(messageId: string): Promise<void> {
    await redis.del(lockKey(messageId));
  },

  // ---- cancellation: works across instances ----

  async requestCancel(messageId: string): Promise<void> {
    await redis.set(cancelKey(messageId), '1', 'EX', env.STREAM_TTL_SECONDS);
  },

  async isCancelled(messageId: string): Promise<boolean> {
    return (await redis.exists(cancelKey(messageId))) === 1;
  },

  async clearCancel(messageId: string): Promise<void> {
    await redis.del(cancelKey(messageId));
  },
};
