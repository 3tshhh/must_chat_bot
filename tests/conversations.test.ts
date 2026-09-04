import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAgent } from '../src/agent/index.js';
import type { ChatAgent } from '../src/agent/types.js';
import { disconnectDatabase, prisma } from '../src/db/prisma.js';
import { disconnectRedis } from '../src/redis/client.js';
import { Client, resetStores, startServer, type TestServer } from './helpers.js';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
  await disconnectRedis();
  await disconnectDatabase();
});

beforeEach(resetStores);
afterEach(() => setAgent(null));

describe('conversation lifecycle', () => {
  it('creates a conversation with a UUID and remembers the anonymous visitor', async () => {
    const client = new Client(server.baseUrl);

    const created = await client.post('/api/conversations');
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(client.cookieHeader).toContain('sid=');

    // Same cookie, so the conversation shows up in this visitor's list.
    const list = await client.json('/api/conversations');
    expect(list.body.items.map((c: any) => c.id)).toContain(created.body.id);
  });

  it('titles the conversation from the first user message', async () => {
    const client = new Client(server.baseUrl);
    const { body: convo } = await client.post('/api/conversations');

    await client.post(`/api/conversations/${convo.id}/messages`, {
      content: 'How do I reset my password?',
    });

    const { body } = await client.json(`/api/conversations/${convo.id}`);
    expect(body.title).toBe('How do I reset my password?');
  });

  it('hides another visitor’s conversation behind a 404', async () => {
    const owner = new Client(server.baseUrl);
    const stranger = new Client(server.baseUrl);

    const { body: convo } = await owner.post('/api/conversations');
    await stranger.post('/api/conversations'); // give the stranger its own session

    const peek = await stranger.json(`/api/conversations/${convo.id}`);
    expect(peek.status).toBe(404);
    expect(peek.body.error.code).toBe('not_found');
  });

  it('soft-deletes so the transcript survives for later review', async () => {
    const client = new Client(server.baseUrl);
    const { body: convo } = await client.post('/api/conversations');

    const del = await client.fetch(`/api/conversations/${convo.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const after = await client.json(`/api/conversations/${convo.id}`);
    expect(after.status).toBe(404);

    const row = await prisma.conversation.findUnique({ where: { id: convo.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
  });

  it('tells the agent to forget the session when a conversation is deleted', async () => {
    const ended: string[] = [];
    const spyAgent: ChatAgent = {
      name: 'spy',
      async *run() {
        yield { type: 'done', finishReason: 'stop' };
      },
      async endSession(conversationId) {
        ended.push(conversationId);
      },
    };
    setAgent(spyAgent);

    const client = new Client(server.baseUrl);
    const { body: convo } = await client.post('/api/conversations');

    const del = await client.fetch(`/api/conversations/${convo.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(ended).toEqual([convo.id]);
  });

  it('still soft-deletes even if the agent session cleanup fails', async () => {
    setAgent({
      name: 'flaky',
      async *run() {
        yield { type: 'done', finishReason: 'stop' };
      },
      async endSession() {
        throw new Error('agent unreachable');
      },
    });

    const client = new Client(server.baseUrl);
    const { body: convo } = await client.post('/api/conversations');

    const del = await client.fetch(`/api/conversations/${convo.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  it('rejects an empty message', async () => {
    const client = new Client(server.baseUrl);
    const { body: convo } = await client.post('/api/conversations');

    const res = await client.post(`/api/conversations/${convo.id}/messages`, { content: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('rejects a 1-character message (the agent requires question.length >= 2)', async () => {
    const client = new Client(server.baseUrl);
    const { body: convo } = await client.post('/api/conversations');

    const res = await client.post(`/api/conversations/${convo.id}/messages`, { content: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('persists the agent-reported onboarding profile on the conversation and message', async () => {
    const client = new Client(server.baseUrl);
    const { body: convo } = await client.post('/api/conversations');

    // mockAgent always reports a fixed profile — see src/agent/mockAgent.ts.
    await client.post(`/api/conversations/${convo.id}/messages`, { content: 'hi there' });

    await waitFor(async () => {
      const row = await prisma.conversation.findUnique({ where: { id: convo.id } });
      return row?.onboardingComplete === true;
    });

    const convoRow = await prisma.conversation.findUnique({ where: { id: convo.id } });
    expect(convoRow?.profile).toMatchObject({ gpa: 3.2, major: 'AI' });
    expect(convoRow?.onboardingComplete).toBe(true);

    const { body } = await client.json(`/api/conversations/${convo.id}`);
    expect(body.profile).toMatchObject({ gpa: 3.2, major: 'AI' });
    expect(body.onboardingComplete).toBe(true);

    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.profile).toMatchObject({ gpa: 3.2, major: 'AI' });
    expect(assistantMsg.onboardingComplete).toBe(true);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor: condition never became true');
}
