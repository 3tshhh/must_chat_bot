import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/redis/client.js';

export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Minimal cookie jar — the anonymous session is the only auth this API has, so
 * every test client needs to hold on to `sid` exactly like a browser would.
 */
export class Client {
  private cookie = '';

  constructor(private readonly baseUrl: string) {}

  get cookieHeader(): string {
    return this.cookie;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair?.startsWith('sid=')) this.cookie = pair;
    }
    return res;
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
  }

  post<T = any>(path: string, body?: unknown) {
    return this.json<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  }
}

export interface SseEvent {
  id?: string;
  event: string;
  data: any;
}

/**
 * Reads an SSE response into a list of events.
 * `stopAfterEvents` lets a test kill the connection mid-stream to exercise resume.
 */
export async function readSse(
  client: Client,
  path: string,
  opts: { lastEventId?: string; stopAfterEvents?: number } = {},
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const res = await client.fetch(path, {
    headers: opts.lastEventId ? { 'last-event-id': opts.lastEventId } : {},
    signal: controller.signal,
  });

  if (!res.ok) throw new Error(`SSE request failed ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error(`no body: ${res.status}`);

  const events: SseEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        events.push(parsed);

        if (opts.stopAfterEvents && events.length >= opts.stopAfterEvents) {
          controller.abort();
          return events;
        }
        if (parsed.event === 'done' || parsed.event === 'error') return events;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }
  return events;
}

function parseFrame(frame: string): SseEvent | null {
  let id: string | undefined;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat / retry comment
    if (line.startsWith('id: ')) id = line.slice(4).trim();
    else if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return null;

  try {
    return { id, event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

export const deltaText = (events: SseEvent[]): string =>
  events
    .filter((e) => e.event === 'delta')
    .map((e) => e.data.text as string)
    .join('');

export async function resetStores(): Promise<void> {
  // A previous test's generation may still be running in the background; deleting
  // its rows out from under it produces confusing Prisma errors in the log.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const inFlight = await prisma.message.count({
      where: { status: { in: ['pending', 'streaming'] } },
    });
    if (inFlight === 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  await prisma.message.deleteMany({});
  await prisma.conversation.deleteMany({});
  await prisma.visitor.deleteMany({});
  const keys = await redis.keys('chat:*');
  if (keys.length) await redis.del(...keys);
}
