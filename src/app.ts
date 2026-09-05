import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmetImport, { type HelmetOptions } from 'helmet';
import { env } from './config/env.js';
import { httpLogger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { visitorSession } from './middleware/visitorSession.js';
import { conversationsRouter } from './routes/conversations.routes.js';
import { healthRouter } from './routes/health.routes.js';

// helmet is always a callable function at runtime, but under NodeNext resolution
// some TypeScript setups (e.g. the Vercel build) resolve its bundled types to a
// non-callable namespace shape. Normalize to the function it actually is.
const helmet = helmetImport as unknown as (
  options?: Readonly<HelmetOptions>,
) => RequestHandler;

export function createApp(): Express {
  const app = express();

  // Behind a proxy/load balancer, so `secure` cookies and req.ip work correctly.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(httpLogger);
  app.use(
    helmet({
      // The API serves JSON and SSE, never HTML, so CSP has nothing to protect.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true, // the visitor cookie must ride along
      exposedHeaders: ['x-request-id'],
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(env.COOKIE_SECRET));

  app.use(healthRouter);

  // Everything below this line has an anonymous visitor attached.
  app.use('/api', visitorSession);
  app.use('/api/conversations', conversationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
