import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    // An SSE response already started; the stream layer owns the failure.
    next(err);
    return;
  }

  if (err instanceof ZodError) {
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
    if (err.status >= 500) logger.error({ err, reqId: req.id }, err.message);
    else logger.debug({ err, reqId: req.id }, err.message);

    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  logger.error({ err, reqId: req.id }, 'unhandled error');
  const fallback = new AppError('internal', 'Something went wrong');
  res.status(500).json({
    error: {
      code: fallback.code,
      message: fallback.message,
      ...(env.isProd ? {} : { debug: (err as Error)?.message, stack: (err as Error)?.stack }),
    },
  });
}
