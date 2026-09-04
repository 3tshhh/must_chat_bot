import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

/**
 * Every log call here carries reqId + method + url, so a real error is always
 * findable and self-contained from a single log line — never just pino-http's
 * generic "failed with status code N" wrapper, which points into pino-http's
 * own internals and names neither the route nor the cause.
 */
function context(req: Request) {
  return { reqId: req.id, method: req.method, url: req.originalUrl };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    // Most likely an SSE response that already started — but the stream route
    // handles its own errors internally and never reaches this branch for that
    // case, so getting here at all means something unexpected happened after
    // headers went out. Log it in full before handing off to Express's default
    // handler (the only option left once headers are sent) — otherwise this
    // 500 has zero record of its real cause anywhere in the logs.
    logger.error({ err, ...context(req) }, 'error after response headers were already sent');
    next(err);
    return;
  }

  if (err instanceof ZodError) {
    logger.debug({ err, ...context(req) }, 'request validation failed');
    res.status(400).json({
      error: {
        code: 'bad_request',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (isAppError(err)) {
    if (err.status >= 500) logger.error({ err, ...context(req) }, err.message);
    else logger.debug({ err, ...context(req) }, err.message);

    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  logger.error({ err, ...context(req) }, 'unhandled error');
  const fallback = new AppError('internal', 'Something went wrong');
  res.status(500).json({
    error: {
      code: fallback.code,
      message: fallback.message,
      ...(env.isProd ? {} : { debug: (err as Error)?.message, stack: (err as Error)?.stack }),
    },
  });
}
