import { Router } from 'express';
import { pingAgentHealth } from '../agent/httpAgent.js';
import { env } from '../config/env.js';
import { pingDatabase } from '../db/prisma.js';
import { pingRedis } from '../redis/client.js';

export const healthRouter = Router();

/** Liveness: is the process up at all. Must not touch dependencies. */
healthRouter.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/** Readiness: can this instance actually serve traffic right now. */
healthRouter.get('/readyz', async (_req, res) => {
  const checks: Record<string, string> = {};
  let ok = true;

  await Promise.all([
    pingDatabase().then(
      () => (checks.database = 'ok'),
      (err) => {
        ok = false;
        checks.database = `error: ${(err as Error).message}`;
      },
    ),
    pingRedis().then(
      () => (checks.redis = 'ok'),
      (err) => {
        ok = false;
        checks.redis = `error: ${(err as Error).message}`;
      },
    ),
  ]);

  // Informational only — the agent being unreachable shouldn't pull this
  // instance out of rotation; browsing/reviewing past conversations still works.
  if (env.AGENT_MODE !== 'mock' && env.AGENT_BASE_URL) {
    const agent = await pingAgentHealth();
    checks.agent = agent.ok ? 'ok' : `warn: ${agent.detail}`;
  }

  res.status(ok ? 200 : 503).json({ ok, checks });
});
