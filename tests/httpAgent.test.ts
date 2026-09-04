import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Exercises httpAgent.ts against a tiny fake server that speaks exactly the
 * contract in MUST_Academic_Assistant_Website_API_Handoff_V1.md ("Stable
 * Contract") — proof the request we send and the response fields we read line
 * up with the doc, independent of the rest of the app (no DB/Redis needed here).
 *
 * env.ts parses process.env once per module load, so AGENT_BASE_URL is set
 * BEFORE the one import of httpAgent.ts below and never changes for the rest
 * of this file — the fake server's address, not its behaviour, is what's fixed.
 */

let server: Server;
let received: { method: string; path: string; body: unknown }[] = [];
let nextChatResponse: unknown;
let nextChatStatus = 200;

const defaultChatResponse = {
  session_id: 'x',
  question: 'x',
  standalone_question: 'x',
  answer: 'AI.499 is Graduation Project II.',
  sources: ['course_AI.499'],
  profile: { gpa: 2.8, completed_hours: 70, major: 'AI', completed_courses: [] },
  onboarding_complete: true,
  history_size: 2,
};

let httpAgent: typeof import('../src/agent/httpAgent.js')['httpAgent'];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      received.push({ method: req.method!, path: req.url!, body });

      if (req.method === 'DELETE') {
        // Matches the doc's exact DELETE /session/{id} response shape.
        const sessionId = req.url!.split('/').pop();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ended', session_id: sessionId }));
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'MUST Academic Assistant API' }));
        return;
      }
      res.writeHead(nextChatStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextChatResponse));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.AGENT_MODE = 'http';
  process.env.AGENT_BASE_URL = baseUrl;
  process.env.AGENT_FAKE_CHUNK_DELAY_MS = '0';

  ({ httpAgent } = await import('../src/agent/httpAgent.js'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // process.env is shared across test files in this worker (fileParallelism is
  // off); leave it as the other files' setup.ts expects.
  process.env.AGENT_MODE = 'mock';
  delete process.env.AGENT_BASE_URL;
});

beforeEach(() => {
  received = [];
  nextChatResponse = defaultChatResponse;
  nextChatStatus = 200;
});

async function drain(question: string, conversationId = 'conv-abc') {
  const chunks = [];
  for await (const c of httpAgent.run({
    conversationId,
    question,
    signal: new AbortController().signal,
  })) {
    chunks.push(c);
  }
  return chunks;
}

describe('httpAgent (against a fake MUST Academic Assistant server)', () => {
  it('POSTs { session_id, question } to /chat and re-emits the answer as deltas', async () => {
    const chunks = await drain('What is AI.499?', 'conv-abc');

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe('POST');
    expect(received[0]!.path).toBe('/chat');
    expect(received[0]!.body).toEqual({ session_id: 'conv-abc', question: 'What is AI.499?' });

    const text = chunks
      .filter((c) => c.type === 'delta')
      .map((c: any) => c.text)
      .join('');
    expect(text).toBe('AI.499 is Graduation Project II.');

    const done = chunks.find((c) => c.type === 'done') as any;
    expect(done.sources).toEqual(['course_AI.499']);
    expect(done.standaloneQuestion).toBe('x');
    expect(done.profile).toEqual({ gpa: 2.8, completedHours: 70, major: 'AI', completedCourses: [] });
    expect(done.onboardingComplete).toBe(true);
  });

  it('uses the conversation id as the session_id — one conversation, one agent session', async () => {
    await drain('hi', 'a-specific-conversation-uuid');
    expect(received[0]!.body).toMatchObject({ session_id: 'a-specific-conversation-uuid' });
  });

  it('DELETEs /session/{id} on endSession', async () => {
    await httpAgent.endSession!('conv-abc');

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe('DELETE');
    expect(received[0]!.path).toBe('/session/conv-abc');
  });

  it('GETs /health for pingAgentHealth', async () => {
    const { pingAgentHealth } = await import('../src/agent/httpAgent.js');
    const result = await pingAgentHealth();

    expect(result.ok).toBe(true);
    expect(received[0]).toMatchObject({ method: 'GET', path: '/health' });
  });

  it('throws agent_unavailable when the response has no "answer" field', async () => {
    nextChatResponse = { session_id: 'x', question: 'x' }; // malformed per the doc
    await expect(drain('hi')).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it('throws agent_unavailable on a non-2xx response', async () => {
    nextChatStatus = 500;
    await expect(drain('hi')).rejects.toMatchObject({ code: 'agent_unavailable' });
  });
});
