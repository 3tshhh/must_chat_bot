import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.isProd
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    remove: true,
  },
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  // SSE connections stay open for minutes; logging them as "slow requests" is noise.
  autoLogging: {
    ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
  },
});
