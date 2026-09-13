import { createApp } from './app.js';
import { assertConfig, config, describeConfig } from './config.js';
import { logger } from './logger.js';
import { watchKnowledge } from './data/knowledge.js';

try {
  assertConfig();
} catch (err) {
  logger.fatal(err.message);
  console.error('\nGenerate a secret and a frontend token with:  npm run token -- --secret\n');
  process.exit(1);
}

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, ...describeConfig() }, `${config.company.name} chatbot backend listening`);
  if (config.openai.mock) {
    logger.warn('running with the MOCK model — set OPENAI_API_KEY for real replies');
  }
  if (!config.webhook.url) {
    logger.warn('LEAD_WEBHOOK_URL is not set — leads will only be written to data/leads.jsonl');
  }
});

if (config.env === 'development') watchKnowledge();

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
