import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['req.headers.authorization', 'lead.email', 'lead.phone'],
    censor: '[redacted]',
  },
  transport:
    config.env === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});
