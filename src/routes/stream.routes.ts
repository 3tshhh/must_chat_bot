import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { openSse, type SseConnection } from '../lib/sse.js';
import { getOwnedConversation } from '../services/conversation.service.js';
import { streamBuffer } from '../services/streamBuffer.js';

const query = z.object({
  messageId: z.string().uuid(),
  lastEventId: z.string().optional(),
});

const TERMINAL = new Set(['complete', 'error', 'cancelled']);

type StoredMessage = {
  id: string;
  status: string;
  content: string;
  errorCode: string | null;
  errorMessage: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  profile: unknown;
  onboardingComplete: boolean | null;
};

/**
 * Emits a finished message straight from Postgres.
 *
 * `reset` rather than `delta` because the client cannot resume by offset here —
 * the buffer's entry ids are gone — so it is told to replace the bubble's contents
 * wholesale instead of appending to whatever it already had.
 */
function replayFromDatabase(sse: SseConnection, message: StoredMessage): void {
  sse.send('reset', { messageId: message.id, content: message.content });

  if (message.promptTokens != null || message.outputTokens != null) {
    sse.send('usage', {
      promptTokens: message.promptTokens,
      outputTokens: message.outputTokens,
    });
  }

  if (message.status === 'error') {
    sse.send('error', {
      code: message.errorCode ?? 'internal',
      message: message.errorMessage ?? 'The assistant failed to respond.',
    });
  } else {
    sse.send('done', {
      messageId: message.id,
      finishReason: message.status === 'cancelled' ? 'cancelled' : 'stop',
      profile: message.profile ?? undefined,
      onboardingComplete: message.onboardingComplete ?? undefined,
    });
  }
}

/**
 * GET /api/conversations/:id/stream?messageId=…
 *
 * Two sources, in priority order:
 *  1. The Redis buffer — replayed from Last-Event-ID, then followed live. This is
 *     the resume path and the normal path both.
 *  2. Postgres — once the buffer has expired, the stored answer is replayed as a
 *     single `reset`.
 *
 * The subtle case is a client that connects *before* the runner writes its first
 * token: the buffer key does not exist yet even though the generation is perfectly
 * healthy. So an absent buffer is only treated as fatal when the message row also
 * says the generation is over — which is re-checked on every idle tick, so a runner
 * that dies mid-answer still ends the stream promptly instead of hanging.
 *
 * Errors must be raised BEFORE the SSE headers go out; afterwards the only way to
 * signal failure is an `error` event on the stream itself.
 */
export async function streamRoute(req: Request, res: Response): Promise<void> {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const q = query.parse(req.query);

  await getOwnedConversation(params.id, req.visitorId);

  const select = {
    id: true,
    status: true,
    content: true,
    errorCode: true,
    errorMessage: true,
    promptTokens: true,
    outputTokens: true,
    profile: true,
    onboardingComplete: true,
  } as const;

  const message = (await prisma.message.findFirst({
    where: { id: q.messageId, conversationId: params.id, role: 'assistant' },
    select,
  })) as StoredMessage | null;
  if (!message) throw AppError.notFound('Message not found');

  // EventSource resends this header automatically on reconnect; the query param is
  // for fetch-based clients that track the cursor themselves.
  const headerId = req.get('last-event-id');
  const lastEventId = (headerId || q.lastEventId || '0').trim();

  const finishedWithNoBuffer =
    TERMINAL.has(message.status) && !(await streamBuffer.exists(message.id));

  const sse = openSse(req, res);

  try {
    if (finishedWithNoBuffer) {
      replayFromDatabase(sse, message);
      return;
    }

    sse.send('open', { messageId: message.id, resumedFrom: lastEventId });

    for await (const tick of streamBuffer.follow(message.id, lastEventId, sse.abort.signal)) {
      if (sse.isClosed) break;

      if (tick.kind === 'idle') {
        // Nothing arrived for a heartbeat interval. Is anyone still generating?
        const current = (await prisma.message.findUnique({
          where: { id: message.id },
          select,
        })) as StoredMessage | null;

        if (!current || !TERMINAL.has(current.status)) continue; // still working
        if (await streamBuffer.exists(message.id)) continue; // terminal event is in the buffer

        // Finished, but its terminal event never made it into the buffer (the
        // runner was killed, or the buffer expired). Fall back to what was saved.
        replayFromDatabase(sse, current);
        return;
      }

      const { entry } = tick;
      switch (entry.event.type) {
        case 'delta':
          sse.send('delta', { text: entry.event.text }, entry.id);
          break;
        case 'usage':
          sse.send(
            'usage',
            {
              promptTokens: entry.event.promptTokens,
              outputTokens: entry.event.outputTokens,
            },
            entry.id,
          );
          break;
        case 'done': {
          // The buffer's `done` entry carries only finishReason; profile and
          // onboarding state land in Postgres in the same transaction that wrote
          // it (see chat.service.ts), so it's already there by the time this
          // fires — one extra read spares the client a refetch to see it.
          const final = (await prisma.message.findUnique({
            where: { id: message.id },
            select: { profile: true, onboardingComplete: true },
          })) as { profile: unknown; onboardingComplete: boolean | null } | null;
          sse.send(
            'done',
            {
              messageId: message.id,
              finishReason: entry.event.finishReason,
              profile: final?.profile ?? undefined,
              onboardingComplete: final?.onboardingComplete ?? undefined,
            },
            entry.id,
          );
          break;
        }
        case 'error':
          sse.send('error', { code: entry.event.code, message: entry.event.message }, entry.id);
          break;
      }
    }
  } catch (err) {
    logger.error({ err, messageId: message.id }, 'sse stream failed');
    sse.send('error', { code: 'internal', message: 'The stream ended unexpectedly.' });
  } finally {
    sse.close();
  }
}
