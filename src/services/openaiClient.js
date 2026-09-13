import OpenAI from 'openai';
import { config } from '../config.js';

let client = null;

/** Lazily constructed so the app can boot (in mock mode) without a key. */
export function getClient() {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  client ??= new OpenAI({ apiKey: config.openai.apiKey, maxRetries: 2, timeout: 60_000 });
  return client;
}

export function isRateLimit(err) {
  return err?.status === 429;
}

export function isBadRequest(err) {
  return err?.status === 400;
}
