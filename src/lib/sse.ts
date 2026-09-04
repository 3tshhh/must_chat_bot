import type { Request, Response } from 'express';
import { env } from '../config/env.js';

/**
 * Minimal SSE writer.
 *
 * The header set matters more than it looks:
 *  - `no-transform` and `X-Accel-Buffering: no` stop nginx and friends from
 *    buffering the response, which is the usual reason streaming "works locally".
 *  - `flushHeaders()` gets the 200 to the browser before the first token exists.
 *  - `retry:` tells EventSource how long to wait before reconnecting.
 */
export class SseConnection {
  private closed = false;
  private heartbeat: NodeJS.Timeout;
  readonly abort = new AbortController();

  constructor(private readonly res: Response, req: Request) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`retry: 2000\n\n`);

    this.heartbeat = setInterval(() => this.comment('ping'), env.SSE_HEARTBEAT_MS);

    const onClose = () => this.close();
    req.on('close', onClose);
    res.on('close', onClose);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** `id` becomes the browser's Last-Event-ID on reconnect. */
  send(event: string, data: unknown, id?: string): void {
    if (this.closed) return;
    let frame = '';
    if (id) frame += `id: ${id}\n`;
    frame += `event: ${event}\n`;
    frame += `data: ${JSON.stringify(data)}\n\n`;
    this.res.write(frame);
  }

  comment(text: string): void {
    if (this.closed) return;
    this.res.write(`: ${text}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.abort.abort();
    try {
      this.res.end();
    } catch {
      /* socket already gone */
    }
  }
}

/** Every currently open SSE response, so shutdown can drain them politely. */
export const openConnections = new Set<SseConnection>();

export function openSse(req: Request, res: Response): SseConnection {
  const conn = new SseConnection(res, req);
  openConnections.add(conn);
  const remove = () => openConnections.delete(conn);
  req.on('close', remove);
  res.on('close', remove);
  return conn;
}

export function closeAllSse(code: string, message: string): void {
  for (const conn of openConnections) {
    conn.send('error', { code, message });
    conn.close();
  }
  openConnections.clear();
}
