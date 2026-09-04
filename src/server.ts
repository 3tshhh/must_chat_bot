import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectDatabase, pingDatabase } from './db/prisma.js';
import { logger } from './lib/logger.js';
import { closeAllSse, openConnections } from './lib/sse.js';
import { disconnectRedis, pingRedis } from './redis/client.js';
import { reapOrphanedGenerations } from './services/chat.service.js';

async function main(): Promise<void> {
  await pingDatabase();
  await pingRedis();
  await reapOrphanedGenerations();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, agent: env.AGENT_MODE },
      'chatbot backend listening',
    );
  });

  // SSE connections idle between tokens; these must exceed any proxy timeout or
  // Node will hang up on a perfectly healthy stream.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, openStreams: openConnections.size }, 'shutting down');

    // Tell open streams to reconnect (likely to another instance) rather than
    // leaving browsers waiting on a socket that is about to vanish.
    closeAllSse('shutdown', 'Server is restarting, please reconnect.');

    server.close(async () => {
      await disconnectRedis();
      await disconnectDatabase();
      logger.info('shutdown complete');
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn('forced exit after shutdown timeout');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
