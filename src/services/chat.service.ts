import { Prisma } from '@prisma/client';
import { getAgent } from '../agent/index.js';
import type { AgentProfile } from '../agent/types.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { deleteConversation as deleteConversationRow, getOwnedConversation } from './conversation.service.js';
import { streamBuffer } from './streamBuffer.js';

const IN_FLIGHT: Prisma.EnumMessageStatusFilter = { in: ['pending', 'streaming'] };
const CANCEL_POLL_EVERY_CHUNKS = 8;

export interface SendResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * Persists the user's turn plus a placeholder assistant turn, then kicks off
 * generation in the background and returns immediately.
 *
 * The response deliberately does NOT stream. The client takes the returned
 * assistantMessageId to `GET /stream`, which means a reload, a second tab or a
 * dropped connection can all rejoin the same generation — impossible if the
 * tokens only ever existed inside this one POST response.
 */
export async function sendMessage(
  conversationId: string,
  visitorId: string,
  content: string,
): Promise<SendResult> {
  const conversation = await getOwnedConversation(conversationId, visitorId);

  const inFlight = await prisma.message.findFirst({
    where: { conversationId, role: 'assistant', status: IN_FLIGHT },
    select: { id: true },
  });
  if (inFlight) {
    throw new AppError(
      'conflict',
      'This conversation already has a reply in progress. Stream or cancel it first.',
      { assistantMessageId: inFlight.id },
    );
  }

  const total = await prisma.message.count({ where: { conversationId } });
  if (total >= env.MAX_MESSAGES_PER_CONVERSATION) {
    throw new AppError(
      'conversation_full',
      `This conversation has reached its ${env.MAX_MESSAGES_PER_CONVERSATION} message limit. Start a new one.`,
    );
  }

  const { userMessage, assistantMessage } = await prisma.$transaction(async (tx) => {
    const last = await tx.message.findFirst({
      where: { conversationId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const nextSeq = (last?.seq ?? -1) + 1;

    const userMessage = await tx.message.create({
      data: {
        conversationId,
        seq: nextSeq,
        role: 'user',
        status: 'complete',
        content,
        completedAt: new Date(),
      },
      select: { id: true, seq: true },
    });

    const assistantMessage = await tx.message.create({
      data: { conversationId, seq: nextSeq + 1, role: 'assistant', status: 'pending' },
      select: { id: true },
    });

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        // First user message doubles as the conversation title until renamed.
        ...(conversation.title ? {} : { title: content.slice(0, 80) }),
      },
    });

    return { userMessage, assistantMessage };
  });

  // One generation per assistant message, even if the POST is retried or two
  // instances somehow both pick it up.
  const locked = await streamBuffer.acquireLock(
    assistantMessage.id,
    Math.ceil(env.AGENT_TIMEOUT_MS / 1000) + 60,
  );
  if (locked) {
    void runGeneration(conversationId, assistantMessage.id, content).catch((err) =>
      logger.error({ err, assistantMessageId: assistantMessage.id }, 'generation crashed'),
    );
  }

  return {
    conversationId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  };
}

/**
 * Drives the agent, appending every chunk to the Redis buffer as it arrives and
 * writing the finished text to Postgres at the end.
 *
 * Invariant this function must never break: an assistant message never stays
 * `pending`/`streaming` after it returns. Every exit path — success, agent error,
 * cancellation, timeout — lands on a terminal status and a terminal buffer event.
 */
export async function runGeneration(
  conversationId: string,
  assistantMessageId: string,
  question: string,
): Promise<void> {
  const startedAt = Date.now();
  const agent = getAgent();
  const abort = new AbortController();

  let text = '';
  let promptTokens: number | undefined;
  let outputTokens: number | undefined;
  let runId: string | undefined;
  let standaloneQuestion: string | undefined;
  let sources: string[] | undefined;
  let profile: AgentProfile | undefined;
  let onboardingComplete: boolean | undefined;
  let cancelled = false;

  try {
    // updateMany, not update: if the row vanished (conversation purged mid-answer)
    // that is a no-op rather than a thrown error and a misleading log line.
    await prisma.message.updateMany({
      where: { id: assistantMessageId },
      data: { status: 'streaming' },
    });

    let sinceCancelCheck = 0;

    // The agent owns conversation memory itself, keyed by session_id (= our
    // conversation id) — we send only the new question, never a transcript.
    for await (const chunk of agent.run({ conversationId, question, signal: abort.signal })) {
      // Cancellation can arrive at any instance, so it lives in Redis and is
      // polled here rather than being a local flag.
      if (++sinceCancelCheck >= CANCEL_POLL_EVERY_CHUNKS) {
        sinceCancelCheck = 0;
        if (await streamBuffer.isCancelled(assistantMessageId)) {
          cancelled = true;
          abort.abort();
          break;
        }
      }

      switch (chunk.type) {
        case 'delta':
          text += chunk.text;
          await streamBuffer.append(assistantMessageId, { type: 'delta', text: chunk.text });
          break;
        case 'usage':
          promptTokens = chunk.promptTokens ?? promptTokens;
          outputTokens = chunk.outputTokens ?? outputTokens;
          await streamBuffer.append(assistantMessageId, chunk);
          break;
        case 'done':
          runId = chunk.runId ?? runId;
          standaloneQuestion = chunk.standaloneQuestion ?? standaloneQuestion;
          sources = chunk.sources ?? sources;
          profile = chunk.profile ?? profile;
          onboardingComplete = chunk.onboardingComplete ?? onboardingComplete;
          break;
      }
    }

    if (!cancelled && (await streamBuffer.isCancelled(assistantMessageId))) cancelled = true;

    await prisma.$transaction([
      prisma.message.updateMany({
        where: { id: assistantMessageId },
        data: {
          status: cancelled ? 'cancelled' : 'complete',
          content: text,
          promptTokens,
          outputTokens,
          latencyMs: Date.now() - startedAt,
          agentRunId: runId ?? null,
          standaloneQuestion: standaloneQuestion ?? null,
          sources: sources ?? undefined,
          profile: (profile as Prisma.InputJsonValue) ?? undefined,
          onboardingComplete: onboardingComplete ?? null,
          completedAt: new Date(),
        },
      }),
      // Mirror the latest onboarding profile onto the conversation so the list/
      // detail views can show it without joining against messages.
      ...(profile !== undefined || onboardingComplete !== undefined
        ? [
            prisma.conversation.updateMany({
              where: { id: conversationId },
              data: {
                ...(profile !== undefined ? { profile: profile as Prisma.InputJsonValue } : {}),
                ...(onboardingComplete !== undefined ? { onboardingComplete } : {}),
              },
            }),
          ]
        : []),
    ]);

    await streamBuffer.append(assistantMessageId, {
      type: 'done',
      finishReason: cancelled ? 'cancelled' : 'stop',
    });
  } catch (err) {
    const code = isAppError(err) ? err.code : 'internal';
    const message = isAppError(err) ? err.message : 'The assistant failed to respond.';
    logger.error({ err, assistantMessageId }, 'generation failed');

    await prisma.message
      .updateMany({
        where: { id: assistantMessageId },
        data: {
          status: 'error',
          content: text,
          errorCode: code,
          errorMessage: message.slice(0, 500),
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      })
      .catch((e) => logger.error({ err: e }, 'failed to persist generation error'));

    await streamBuffer
      .append(assistantMessageId, { type: 'error', code, message })
      .catch(() => undefined);
  } finally {
    await streamBuffer.clearCancel(assistantMessageId).catch(() => undefined);
    await streamBuffer.releaseLock(assistantMessageId).catch(() => undefined);
  }
}

/**
 * Soft-deletes the conversation and, best-effort, tells the agent to forget its
 * session for it. A failure to reach the agent must not block the user's delete —
 * an orphaned agent-side session just means a very slightly overlong memory.
 */
export async function deleteConversationAndSession(
  conversationId: string,
  visitorId: string,
): Promise<void> {
  await deleteConversationRow(conversationId, visitorId);
  const agent = getAgent();
  if (agent.endSession) {
    await agent.endSession(conversationId).catch((err) =>
      logger.warn({ err, conversationId }, 'agent session cleanup failed'),
    );
  }
}

export async function cancelGeneration(
  conversationId: string,
  visitorId: string,
  assistantMessageId: string,
): Promise<void> {
  await getOwnedConversation(conversationId, visitorId);

  const message = await prisma.message.findFirst({
    where: { id: assistantMessageId, conversationId, role: 'assistant' },
    select: { id: true, status: true },
  });
  if (!message) throw AppError.notFound('Message not found');
  if (message.status !== 'pending' && message.status !== 'streaming') return; // already finished

  await streamBuffer.requestCancel(assistantMessageId);
}

/**
 * Marks orphaned generations as failed — rows left `pending`/`streaming` by a
 * process that died mid-answer, which nobody is going to finish.
 *
 * The age filter is what makes this safe to run at boot with several instances
 * live: anything younger than the agent timeout could still legitimately be
 * generating on a sibling instance, so it is left alone.
 */
export async function reapOrphanedGenerations(): Promise<number> {
  const cutoff = new Date(Date.now() - env.AGENT_TIMEOUT_MS - 60_000);
  const { count } = await prisma.message.updateMany({
    where: { role: 'assistant', status: IN_FLIGHT, createdAt: { lt: cutoff } },
    data: {
      status: 'error',
      errorCode: 'internal',
      errorMessage: 'Generation was interrupted by a server restart.',
      completedAt: new Date(),
    },
  });
  if (count > 0) logger.warn({ count }, 'reaped interrupted generations at startup');
  return count;
}
