import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const prisma = new PrismaClient({
  log: env.isProd ? ['warn', 'error'] : ['warn', 'error'],
});

export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.warn({ err }, 'error while disconnecting prisma');
  }
}
