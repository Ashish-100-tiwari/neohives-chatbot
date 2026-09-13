import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { requireToken } from './auth/token.js';
import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();

  // Needed for correct client IPs (rate limiting, lead context) behind a proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const allowAll = config.allowedOrigins.length === 0 || config.allowedOrigins.includes('*');
  if (allowAll && config.env === 'production') {
    logger.warn('ALLOWED_ORIGINS is not set — the API accepts requests from any origin');
  }
  app.use(
    cors({
      origin: allowAll ? true : config.allowedOrigins,
      methods: ['POST'],
      allowedHeaders: ['content-type', 'authorization'],
      maxAge: 86_400,
    }),
  );

  // Conversation state travels in the request body, so allow room for it.
  app.use(express.json({ limit: '256kb' }));

  // Liveness probe for the platform (Render/Fly/K8s). Not part of the API and
  // intentionally says nothing about configuration; delete it if unused.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // The single API endpoint: token-guarded and rate limited per IP. The token is
  // shared by every visitor, so limiting per token would be pointless.
  app.use(
    '/api/chat',
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited', reply: 'Too many messages — please slow down a little.' },
    }),
    requireToken,
  );
  app.use('/api', apiRouter);

  // Local test console. Never served in production — it is a dev tool.
  if (config.env !== 'production') {
    app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'invalid_json' });
    }
    logger.error({ err }, 'unhandled request error');
    res.status(500).json({
      error: 'internal_error',
      message: `Something went wrong on our side. Please try again, or email ${config.company.contactEmail}.`,
    });
  });

  return app;
}
