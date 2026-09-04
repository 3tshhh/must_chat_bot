import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { AgentChunk, AgentProfile, AgentRunInput, ChatAgent } from './types.js';

/**
 * Adapter for the MUST Academic Assistant, per
 * MUST_Academic_Assistant_Website_API_Handoff_V1.md ("Stable Contract —
 * Production Text Backend V1"). Production base URL:
 * https://must-academic-assistant-backend.onrender.com
 *
 *   POST {AGENT_BASE_URL}/chat
 *     -> { session_id, question }                     (session_id >= 8 chars, question >= 2 chars)
 *     <- { session_id, question, standalone_question, answer, sources,
 *          profile: { gpa, completed_hours, major, completed_courses },
 *          onboarding_complete, history_size }
 *
 *   DELETE {AGENT_BASE_URL}/session/{session_id}   -> { status: "ended", session_id }
 *     Best-effort session cleanup. Per the doc, reusing the same id afterwards
 *     restarts onboarding from scratch — so this is only called when the user
 *     actually deletes the conversation, never speculatively.
 *
 *   GET {AGENT_BASE_URL}/health -> { status: "ok", service: "..." }
 *
 * It's a single JSON reply, not a stream — so, same trick as any non-streaming
 * backend here: the answer is re-emitted as small deltas so the browser still
 * paints progressively. `session_id` is our conversation UUID; the agent tracks
 * history and the onboarding profile itself, so we send only the new question,
 * never a transcript.
 *
 * Per the doc's error table: 422 means we sent a malformed request (schema
 * problem on our end, since our own validation should prevent this), 500 means
 * the agent/provider failed. Both surface here as `agent_unavailable` — the
 * distinction matters for debugging (see the logged status/body) but not for
 * how the user-facing error is presented.
 */

interface ChatResponseBody {
  session_id?: string;
  question?: string;
  standalone_question?: string;
  answer?: string;
  sources?: string[];
  profile?: {
    gpa?: number | null;
    completed_hours?: number | null;
    major?: string | null;
    completed_courses?: string[] | null;
  };
  onboarding_complete?: boolean;
  history_size?: number;
}

function chatUrl(): string {
  return `${env.AGENT_BASE_URL}/chat`;
}

function sessionUrl(conversationId: string): string {
  return `${env.AGENT_BASE_URL}/session/${encodeURIComponent(conversationId)}`;
}

function authHeaders(): Record<string, string> {
  // The doc lists no auth scheme for this endpoint (it's designed to be callable
  // directly from a browser); AGENT_API_KEY is sent only if you've set one.
  return env.AGENT_API_KEY ? { authorization: `Bearer ${env.AGENT_API_KEY}` } : {};
}

function mapProfile(profile: ChatResponseBody['profile']): AgentProfile | undefined {
  if (!profile) return undefined;
  return {
    gpa: profile.gpa,
    completedHours: profile.completed_hours,
    major: profile.major,
    completedCourses: profile.completed_courses,
  };
}

/** GET {AGENT_BASE_URL}/health — used by /readyz as informational, non-blocking context. */
export async function pingAgentHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${env.AGENT_BASE_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? { ok: true, detail: 'ok' } : { ok: false, detail: `status ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export const httpAgent: ChatAgent = {
  name: 'http',

  async *run(input: AgentRunInput): AsyncIterable<AgentChunk> {
    const timeout = AbortSignal.timeout(env.AGENT_TIMEOUT_MS);
    const signal = AbortSignal.any([input.signal, timeout]);

    let res: Response;
    try {
      res = await fetch(chatUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ session_id: input.conversationId, question: input.question }),
        signal,
      });
    } catch (err) {
      if (input.signal.aborted) return;
      if (timeout.aborted) {
        throw new AppError('agent_timeout', 'Agent service did not respond in time');
      }
      throw new AppError('agent_unavailable', 'Could not reach the agent service', {
        cause: (err as Error).message,
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AppError('agent_unavailable', `Agent service responded ${res.status}`, {
        status: res.status,
        body: body.slice(0, 500),
      });
    }

    const payload = (await res.json().catch(() => {
      throw new AppError('agent_unavailable', 'Agent service returned invalid JSON');
    })) as ChatResponseBody;

    if (typeof payload.answer !== 'string' || payload.answer.length === 0) {
      throw new AppError('agent_unavailable', 'Agent response had no "answer" field', {
        received: Object.keys(payload ?? {}),
      });
    }

    // Re-emit as deltas so the UI paints progressively instead of jumping from an
    // empty bubble to a wall of text.
    const size = env.AGENT_FAKE_CHUNK_CHARS;
    for (let i = 0; i < payload.answer.length; i += size) {
      if (input.signal.aborted) return;
      yield { type: 'delta', text: payload.answer.slice(i, i + size) };
      if (env.AGENT_FAKE_CHUNK_DELAY_MS > 0) {
        await delay(env.AGENT_FAKE_CHUNK_DELAY_MS, undefined, { signal: input.signal }).catch(
          () => undefined,
        );
      }
    }

    yield {
      type: 'done',
      finishReason: 'stop',
      standaloneQuestion: payload.standalone_question,
      sources: payload.sources,
      profile: mapProfile(payload.profile),
      onboardingComplete: payload.onboarding_complete,
    };
  },

  async endSession(conversationId: string): Promise<void> {
    try {
      const res = await fetch(sessionUrl(conversationId), {
        method: 'DELETE',
        headers: authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      // 404 just means the agent never opened a session for this conversation
      // (e.g. it was deleted before a first message was sent) — not a failure.
      if (!res.ok && res.status !== 404) {
        logger.warn({ conversationId, status: res.status }, 'agent session cleanup responded non-2xx');
        return;
      }
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        if (body && body.status !== 'ended') {
          logger.warn({ conversationId, body }, 'agent session cleanup returned unexpected body');
        }
      }
    } catch (err) {
      // Best-effort: an orphaned session on the agent side is not worth failing
      // the user's delete request over.
      logger.warn({ err, conversationId }, 'failed to clean up agent session');
    }
  },
};
