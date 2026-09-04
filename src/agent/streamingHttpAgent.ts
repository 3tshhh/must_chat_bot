import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import type { AgentChunk, AgentRunInput, ChatAgent } from './types.js';

/**
 * Placeholder for the day the MUST Academic Assistant streams `/chat`.
 *
 * MUST_Agent_Frontend_API_Integration_Guide.md documents `/chat` as a single JSON
 * reply today — this file is speculative, not confirmed against any doc. It
 * assumes a streamed body of NDJSON or SSE `data:` lines reusing the same field
 * names as the JSON contract (`answer`/`sources`/`standalone_question`) with the
 * chat request still `{ session_id, question }`. Re-verify with the agent team
 * before flipping AGENT_MODE to "http-stream" — this is a guess at the shape,
 * not a known one.
 *
 * Per line, understood today:
 *   {"delta":"..."} | {"answer":"..."} | {"token":"..."}
 *   {"type":"done","standalone_question":"...","sources":[...]}  | the literal [DONE]
 */

function parseLine(line: string): AgentChunk | null {
  let payload = line.trim();
  if (!payload) return null;
  if (payload.startsWith(':') || payload.startsWith('event:')) return null; // SSE comment/heartbeat
  if (payload.startsWith('data:')) payload = payload.slice(5).trim();
  if (!payload || payload === '[DONE]') {
    return payload === '[DONE]' ? { type: 'done', finishReason: 'stop' } : null;
  }

  let obj: any;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null; // ignore anything unparseable rather than killing the stream
  }

  if (obj.type === 'done' || obj.finish_reason) {
    return {
      type: 'done',
      finishReason: obj.finish_reason ?? 'stop',
      standaloneQuestion: obj.standalone_question,
      sources: obj.sources,
    };
  }

  const text = obj.delta ?? obj.token ?? obj.answer ?? obj.text;
  if (typeof text === 'string' && text.length > 0) return { type: 'delta', text };
  return null;
}

export const streamingHttpAgent: ChatAgent = {
  name: 'http-stream',

  async *run(input: AgentRunInput): AsyncIterable<AgentChunk> {
    const timeout = AbortSignal.timeout(env.AGENT_TIMEOUT_MS);
    const signal = AbortSignal.any([input.signal, timeout]);

    let res: Response;
    try {
      res = await fetch(`${env.AGENT_BASE_URL}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream, application/x-ndjson',
          ...(env.AGENT_API_KEY ? { authorization: `Bearer ${env.AGENT_API_KEY}` } : {}),
        },
        body: JSON.stringify({ session_id: input.conversationId, question: input.question, stream: true }),
        signal,
      });
    } catch (err) {
      if (input.signal.aborted) return;
      if (timeout.aborted) throw new AppError('agent_timeout', 'Agent service did not respond in time');
      throw new AppError('agent_unavailable', 'Could not reach the agent service', {
        cause: (err as Error).message,
      });
    }

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new AppError('agent_unavailable', `Agent service responded ${res.status}`, {
        status: res.status,
        body: body.slice(0, 500),
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;

    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (input.signal.aborted) return;
      buffer += decoder.decode(bytes, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const chunk = parseLine(line);
        if (!chunk) continue;
        if (chunk.type === 'done') sawDone = true;
        yield chunk;
      }
    }

    const tail = parseLine(buffer);
    if (tail) {
      if (tail.type === 'done') sawDone = true;
      yield tail;
    }
    if (!sawDone) yield { type: 'done', finishReason: 'stop' };
  },
};
