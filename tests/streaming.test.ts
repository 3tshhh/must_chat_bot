import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAgent } from '../src/agent/index.js';
import type { AgentChunk, AgentRunInput, ChatAgent } from '../src/agent/types.js';
import { disconnectDatabase, prisma } from '../src/db/prisma.js';
import { disconnectRedis } from '../src/redis/client.js';
import { streamBuffer } from '../src/services/streamBuffer.js';
import {
  Client,
  deltaText,
  readSse,
  resetStores,
  startServer,
  type TestServer,
} from './helpers.js';

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

/** An agent whose pace and failure mode each test can dictate. */
function scriptedAgent(chunks: string[], opts: { delayMs?: number; throwAfter?: number } = {}): ChatAgent {
  return {
    name: 'scripted',
    async *run({ signal }: AgentRunInput): AsyncIterable<AgentChunk> {
      let i = 0;
      for (const text of chunks) {
        if (signal.aborted) return;
        if (opts.throwAfter !== undefined && i === opts.throwAfter) {
          throw new Error('scripted agent blew up');
        }
        yield { type: 'delta', text };
        i++;
        if (opts.delayMs) await delay(opts.delayMs);
      }
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

async function newConversation(client: Client): Promise<string> {
  const { body } = await client.post('/api/conversations');
  return body.id;
}

async function waitForStatus(messageId: string, statuses: string[], timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.message.findUnique({ where: { id: messageId } });
    if (row && statuses.includes(row.status)) return row;
    await delay(25);
  }
  throw new Error(`message ${messageId} never reached ${statuses.join('|')}`);
}

describe('streaming', () => {
  it('streams deltas and persists the assembled answer', async () => {
    setAgent(scriptedAgent(['Hello', ' ', 'world', '!']));
    const client = new Client(server.baseUrl);
    const convoId = await newConversation(client);

    const send = await client.post(`/api/conversations/${convoId}/messages`, { content: 'hi' });
    expect(send.status).toBe(202);

    const events = await readSse(client, send.body.streamUrl);
    expect(deltaText(events)).toBe('Hello world!');
    expect(events.at(-1)!.event).toBe('done');

    const row = await waitForStatus(send.body.assistantMessageId, ['complete']);
    expect(row.content).toBe('Hello world!');

    // The transcript endpoint is what a reviewer would read later.
    const { body } = await client.json(`/api/conversations/${convoId}`);
    expect(body.messages.map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello world!'],
    ]);
  });

  it('resumes from Last-Event-ID with no gap and no duplication', async () => {
    setAgent(scriptedAgent(['aaa', 'bbb', 'ccc', 'ddd', 'eee'], { delayMs: 40 }));
    const client = new Client(server.baseUrl);
    const convoId = await newConversation(client);
    const send = await client.post(`/api/conversations/${convoId}/messages`, { content: 'hi' });

    // Drop the connection after the first couple of events.
    const first = await readSse(client, send.body.streamUrl, { stopAfterEvents: 3 });
    const seen = deltaText(first);
    const lastId = [...first].reverse().find((e) => e.id)!.id!;
    expect(seen.length).toBeGreaterThan(0);

    const second = await readSse(client, send.body.streamUrl, { lastEventId: lastId });
    expect(second.at(-1)!.event).toBe('done');

    // Concatenating the two sessions reproduces the answer exactly once.
    expect(seen + deltaText(second)).toBe('aaabbbcccdddeee');
  });

  it('replays the stored answer when the buffer is gone', async () => {
    setAgent(scriptedAgent(['stored ', 'answer']));
    const client = new Client(server.baseUrl);
    const convoId = await newConversation(client);
    const send = await client.post(`/api/conversations/${convoId}/messages`, { content: 'hi' });

    await readSse(client, send.body.streamUrl);
    await waitForStatus(send.body.assistantMessageId, ['complete']);

    await streamBuffer.drop(send.body.assistantMessageId);
    expect(await streamBuffer.exists(send.body.assistantMessageId)).toBe(false);

    const events = await readSse(client, send.body.streamUrl);
    expect(events[0]!.event).toBe('reset');
    expect(events[0]!.data.content).toBe('stored answer');
    expect(events.at(-1)!.event).toBe('done');
  });

  it('reports agent failure on the stream and never leaves the row pending', async () => {
    setAgent(scriptedAgent(['partial', 'never sent'], { throwAfter: 1 }));
    const client = new Client(server.baseUrl);
    const convoId = await newConversation(client);
    const send = await client.post(`/api/conversations/${convoId}/messages`, { content: 'hi' });

    const events = await readSse(client, send.body.streamUrl);
    expect(events.at(-1)!.event).toBe('error');

    const row = await waitForStatus(send.body.assistantMessageId, ['error']);
    expect(row.content).toBe('partial'); // whatever arrived before the failure is kept
    expect(row.errorMessage).toBeTruthy();
  });

  it('cancels mid-generation and keeps the partial text', async () => {
    setAgent(scriptedAgent(Array.from({ length: 60 }, (_, i) => `${i} `), { delayMs: 20 }));
    const client = new Client(server.baseUrl);
    const convoId = await newConversation(client);
    const send = await client.post(`/api/conversations/${convoId}/messages`, { content: 'hi' });

    await delay(250);
    const cancel = await client.post(
      `/api/conversations/${convoId}/messages/${send.body.assistantMessageId}/cancel`,
    );
    expect(cancel.status).toBe(202);

    const row = await waitForStatus(send.body.assistantMessageId, ['cancelled', 'complete']);
    expect(row.status).toBe('cancelled');
    expect(row.content.length).toBeGreaterThan(0);
    expect(row.content.length).toBeLessThan(200); // stopped well before the end
  });

  it('refuses a second message while a reply is in flight', async () => {
    setAgent(scriptedAgent(['slow'], { delayMs: 400 }));
    const client = new Client(server.baseUrl);
    const convoId = await newConversation(client);

    await client.post(`/api/conversations/${convoId}/messages`, { content: 'first' });
    const second = await client.post(`/api/conversations/${convoId}/messages`, {
      content: 'second',
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
  });

  it('will not stream another visitor’s message', async () => {
    setAgent(scriptedAgent(['secret']));
    const owner = new Client(server.baseUrl);
    const stranger = new Client(server.baseUrl);
    const convoId = await newConversation(owner);
    const send = await owner.post(`/api/conversations/${convoId}/messages`, { content: 'hi' });

    await stranger.post('/api/conversations');
    const res = await stranger.json(send.body.streamUrl);
    expect(res.status).toBe(404);
  });
});
