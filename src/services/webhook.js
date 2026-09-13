import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const LEAD_LOG = `${DATA_DIR}leads.jsonl`;
const DEAD_LETTER = `${DATA_DIR}failed-webhooks.jsonl`;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Human-quotable reference the visitor can use in a follow-up email. */
export function newReference(prefix = 'NH') {
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `${prefix}-${date}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

export function signPayload(rawBody, secret = config.webhook.secret) {
  if (!secret) return null;
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** For the receiving end (or tests) to verify a delivery came from us. */
export function verifySignature(rawBody, signature, secret = config.webhook.secret) {
  const expected = signPayload(rawBody, secret);
  if (!expected || !signature) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function appendJsonl(file, record) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    logger.error({ err, file }, 'failed to write local lead record');
  }
}

/**
 * Builds the outbound payload. Keep this stable — downstream automations
 * (n8n/Zapier/CRM field mappings) depend on the exact key names.
 */
export function buildPayload({ event, conversation, lead, reference, extra = {}, transcript = [] }) {
  return {
    event,
    reference,
    submitted_at: new Date().toISOString(),
    source: 'website-chatbot',
    company: config.company.name,
    session: {
      id: conversation?.id ?? null,
      started_at: conversation?.createdAt ?? null,
      message_count: conversation?.messages?.length ?? 0,
      turns: conversation?.turns ?? 0,
    },
    lead: {
      name: lead?.name ?? null,
      email: lead?.email ?? null,
      phone: lead?.phone ?? null,
      company: lead?.company ?? null,
      country: lead?.country ?? null,
      industry: lead?.industry ?? null,
      service_interest: lead?.service_interest ?? null,
      requirement: lead?.requirement ?? null,
      current_technology: lead?.current_technology ?? null,
      required_integrations: lead?.required_integrations ?? null,
      expected_volume: lead?.expected_volume ?? null,
      number_of_users: lead?.number_of_users ?? null,
      budget_range: lead?.budget_range ?? null,
      timeline: lead?.timeline ?? null,
      preferred_contact_time: lead?.preferred_contact_time ?? null,
      notes: lead?.notes ?? null,
    },
    context: {
      page_url: conversation?.origin?.pageUrl ?? null,
      referrer: conversation?.origin?.referrer ?? null,
      locale: conversation?.origin?.locale ?? null,
      utm: conversation?.origin?.utm ?? null,
      user_agent: conversation?.request?.userAgent ?? null,
      ip: conversation?.request?.ip ?? null,
    },
    transcript,
    ...extra,
  };
}

/**
 * Delivers a payload to the configured webhook with exponential backoff.
 * Every payload is also appended to data/leads.jsonl first, so a lead is never
 * lost even if the webhook is down or unconfigured.
 */
export async function deliver(payload, { url = config.webhook.url } = {}) {
  await appendJsonl(LEAD_LOG, payload);

  if (!url) {
    logger.warn({ reference: payload.reference }, 'LEAD_WEBHOOK_URL not set — lead saved locally only');
    return { ok: true, delivery: 'skipped', reference: payload.reference };
  }

  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody);
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, config.webhook.maxRetries); attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `${config.company.name}-chatbot/1.0`,
          'x-neohives-event': payload.event,
          'x-neohives-timestamp': String(Date.now()),
          ...(signature ? { 'x-neohives-signature': signature } : {}),
        },
        body: rawBody,
        signal: AbortSignal.timeout(config.webhook.timeoutMs),
      });

      if (response.ok) {
        logger.info({ reference: payload.reference, attempt, status: response.status }, 'lead delivered');
        return { ok: true, delivery: 'delivered', reference: payload.reference, status: response.status };
      }

      lastError = new Error(`webhook responded ${response.status}`);
      if (!RETRYABLE_STATUS.has(response.status)) break;
    } catch (err) {
      lastError = err;
    }

    if (attempt < config.webhook.maxRetries) {
      const backoff = 400 * 2 ** (attempt - 1);
      logger.warn({ attempt, backoff, err: lastError?.message }, 'webhook delivery failed — retrying');
      await sleep(backoff);
    }
  }

  logger.error({ reference: payload.reference, err: lastError?.message }, 'webhook delivery failed permanently');
  await appendJsonl(DEAD_LETTER, { failed_at: new Date().toISOString(), error: lastError?.message, payload });
  // The lead itself is safe on disk, so the caller can still hand the visitor a
  // reference; `delivery` tells ops that a manual replay is needed.
  return { ok: true, delivery: 'queued', reference: payload.reference, error: lastError?.message };
}
