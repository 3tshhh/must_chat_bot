/**
 * Contract confirmed against MUST_Academic_Assistant_Website_API_Handoff_V1.md
 * (the authoritative "Stable Contract — Production Text Backend V1" doc; the
 * older MUST_Agent_Frontend_API_Integration_Guide.md is the same shape without
 * the onboarding profile fields).
 *
 * The agent service owns conversation memory itself, keyed by `session_id` — it
 * does follow-up detection, standalone-question rewriting, and a GPA/hours/major
 * onboarding flow, all server-side. We do NOT send it a history array; we send
 * the one new question and it looks up the rest by session id. That id is
 * exactly our conversation UUID: one conversation here = one session there,
 * same lifecycle (new chat -> new id, refresh -> same id), so no separate
 * mapping table is needed. `session_id` must be >= 8 chars and `question` >= 2
 * chars per the doc; our UUIDs and message-length validation already satisfy
 * both.
 */

/** The agent's per-session advising state, as of the latest turn. */
export interface AgentProfile {
  gpa?: number | null;
  completedHours?: number | null;
  major?: string | null;
  completedCourses?: string[] | null;
}

/** What an agent implementation yields. Also, one-for-one, what the SSE endpoint
 *  emits — chunking a single JSON reply into deltas or relaying a real stream
 *  looks identical from here down. */
export type AgentChunk =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens?: number; outputTokens?: number }
  | {
      type: 'done';
      finishReason: string;
      runId?: string;
      /** Agent's rewrite of a follow-up into a standalone question, e.g. "its prerequisite" -> "AI.499's prerequisite". */
      standaloneQuestion?: string;
      /** Source ids the answer was grounded on, e.g. ["course_AI.499"]. */
      sources?: string[];
      /** Present once the backend has collected/updated it; optional UI/review state, not academic logic we implement ourselves. */
      profile?: AgentProfile;
      onboardingComplete?: boolean;
    };

export interface AgentRunInput {
  /** Doubles as the agent's session_id. */
  conversationId: string;
  /** The new user message. The agent looks up prior turns itself by session_id. */
  question: string;
  signal: AbortSignal;
}

export interface ChatAgent {
  readonly name: string;
  run(input: AgentRunInput): AsyncIterable<AgentChunk>;
  /**
   * Best-effort: tell the agent to drop its memory (and onboarding profile) for
   * this conversation. Optional because not every implementation (mock, a future
   * streaming variant) necessarily needs to do anything here.
   */
  endSession?(conversationId: string): Promise<void>;
}
