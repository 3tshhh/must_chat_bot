import { env } from '../config/env.js';
import { httpAgent } from './httpAgent.js';
import { mockAgent } from './mockAgent.js';
import { streamingHttpAgent } from './streamingHttpAgent.js';
import type { ChatAgent } from './types.js';

let override: ChatAgent | null = null;

/** Tests swap in a fake here instead of standing up an HTTP server. */
export function setAgent(agent: ChatAgent | null): void {
  override = agent;
}

export function getAgent(): ChatAgent {
  if (override) return override;
  switch (env.AGENT_MODE) {
    case 'http':
      return httpAgent;
    case 'http-stream':
      return streamingHttpAgent;
    case 'mock':
    default:
      return mockAgent;
  }
}

export type { AgentChunk, AgentProfile, AgentRunInput, ChatAgent } from './types.js';
