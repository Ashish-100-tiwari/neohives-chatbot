import 'dotenv/config';

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const jwtSecret = process.env.JWT_SECRET ?? '';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),

  company: {
    name: 'Neo Hives IT Solutions',
    shortName: 'Neo Hives',
    domain: 'neohives.com',
    website: 'https://www.neohives.com',
    // Fallback copy uses this when the assistant itself is unavailable, so it
    // must not depend on the knowledge base having loaded. Keep the two in sync.
    contactEmail: 'info.neohives@gmail.com',
    phone: '+91 7982015467',
  },

  auth: {
    secret: jwtSecret,
    issuer: process.env.JWT_ISSUER ?? 'neohives.com',
    audience: process.env.JWT_AUDIENCE ?? 'neohives-chatbot',
    // jti values listed here are rejected — lets you kill a leaked token
    // without rotating the secret (which invalidates every token at once).
    revokedIds: list(process.env.REVOKED_TOKEN_IDS),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    temperature: num(process.env.OPENAI_TEMPERATURE, 0.3),
    maxOutputTokens: num(process.env.OPENAI_MAX_OUTPUT_TOKENS, 700),
    // Falls back to mock mode automatically when no key is configured, so the
    // service still boots (and tests still run) without credentials.
    mock: bool(process.env.MOCK_LLM) || !process.env.OPENAI_API_KEY,
  },

  webhook: {
    url: process.env.LEAD_WEBHOOK_URL ?? '',
    secret: process.env.LEAD_WEBHOOK_SECRET ?? '',
    timeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 10_000),
    maxRetries: num(process.env.WEBHOOK_MAX_RETRIES, 3),
  },

  // The conversation lives in the browser's localStorage as a signed blob;
  // the server keeps nothing between requests.
  conversation: {
    // Falls back to the JWT secret so there is one less required env var, but a
    // separate secret is better: it can be rotated without reissuing tokens.
    secret: process.env.STATE_SECRET || jwtSecret,
    maxHistoryMessages: num(process.env.MAX_HISTORY_MESSAGES, 30),
    maxTurns: num(process.env.MAX_TURNS_PER_CONVERSATION, 40),
    maxStateBytes: num(process.env.MAX_STATE_BYTES, 128_000),
  },

  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: num(process.env.RATE_LIMIT_MAX, 20),
  },

  // Hard stop on tool-calling loops so a confused model can't burn tokens.
  maxToolIterations: 6,
};

/** Fails fast at boot rather than 500-ing on the first request. */
export function assertConfig() {
  const problems = [];
  if (!config.auth.secret) problems.push('JWT_SECRET is required (run: npm run token)');
  if (config.auth.secret && config.auth.secret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters');
  }
  if (!config.conversation.secret) problems.push('STATE_SECRET (or JWT_SECRET) is required');
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

export function describeConfig() {
  return {
    env: config.env,
    model: config.openai.model,
    llm: config.openai.mock ? 'mock' : 'openai',
    webhookConfigured: Boolean(config.webhook.url),
    webhookSigned: Boolean(config.webhook.secret),
  };
}
