import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';

const COOKIE_NAME = 'sid';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      visitorId: string;
    }
  }
}

/** Never store a raw IP; a salted hash is enough to trace abuse. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(env.IP_HASH_SALT).update(ip).digest('hex').slice(0, 32);
}

function setCookie(res: Response, visitorId: string): void {
  res.cookie(COOKIE_NAME, visitorId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    signed: true,
    maxAge: ONE_YEAR_MS,
    path: '/',
  });
}

/**
 * Resolves the anonymous visitor for every request, minting one on first contact.
 * Conversation ownership hangs off this id — there are no accounts.
 */
export async function visitorSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cookieId = req.signedCookies?.[COOKIE_NAME] as string | undefined;

    if (cookieId) {
      const existing = await prisma.visitor.findUnique({
        where: { id: cookieId },
        select: { id: true },
      });
      if (existing) {
        req.visitorId = existing.id;
        // Touch lastSeenAt without blocking the request.
        void prisma.visitor
          .update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } })
          .catch(() => undefined);
        next();
        return;
      }
      // Cookie points at a visitor that no longer exists (pruned DB, restored
      // backup): fall through and mint a fresh one rather than 500.
    }

    const visitor = await prisma.visitor.create({
      data: {
        userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
        ipHash: hashIp(req.ip),
      },
      select: { id: true },
    });

    setCookie(res, visitor.id);
    req.visitorId = visitor.id;
    next();
  } catch (err) {
    next(err);
  }
}
