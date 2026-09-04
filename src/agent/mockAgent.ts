import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../config/env.js';
import type { AgentChunk, AgentRunInput, ChatAgent } from './types.js';

const FILLER =
  'This is a deterministic mock answer so the streaming pipeline can be exercised without the real agent service. It arrives as several delta batches, which is enough to verify ordering, resume and cancellation end to end.';

/**
 * Deterministic, network-free agent used by tests and by `AGENT_MODE=mock`.
 * Echoes the question so assertions can tie a response to its prompt, and fakes
 * the same `sources` / `standaloneQuestion` metadata the real agent returns.
 */
export const mockAgent: ChatAgent = {
  name: 'mock',

  async *run({ question, signal }: AgentRunInput): AsyncIterable<AgentChunk> {
    const reply = `You asked: "${question}". ${FILLER}`;

    const size = env.AGENT_FAKE_CHUNK_CHARS;
    for (let i = 0; i < reply.length; i += size) {
      if (signal.aborted) return;
      yield { type: 'delta', text: reply.slice(i, i + size) };
      if (env.AGENT_FAKE_CHUNK_DELAY_MS > 0) {
        await delay(env.AGENT_FAKE_CHUNK_DELAY_MS, undefined, { signal }).catch(() => undefined);
      }
    }

    yield {
      type: 'usage',
      promptTokens: Math.ceil(question.length / 4),
      outputTokens: Math.ceil(reply.length / 4),
    };
    yield {
      type: 'done',
      finishReason: 'stop',
      standaloneQuestion: question,
      sources: ['mock_source_1'],
      profile: { gpa: 3.2, completedHours: 70, major: 'AI', completedCourses: [] },
      onboardingComplete: true,
    };
  },

  async endSession(): Promise<void> {
    // Nothing to clean up — the mock never opened a session anywhere.
  },
};
