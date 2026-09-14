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

export function isFormspreeUrl(url) {
  try {
    return /(^|\.)formspree\.io$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Formspree rejects oversized submissions, and a 40-turn transcript is big. */
const MAX_FIELD_CHARS = 4000;

const clamp = (value, max = MAX_FIELD_CHARS) => {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

const LABELS = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  country: 'Country',
  industry: 'Industry',
  service_interest: 'Service interest',
  requirement: 'Requirement',
  current_technology: 'Current technology',
  required_integrations: 'Required integrations',
  expected_volume: 'Expected volume',
  number_of_users: 'Number of users',
  budget_range: 'Budget range',
  timeline: 'Timeline',
  preferred_contact_time: 'Preferred contact time',
  notes: 'Notes',
};

/**
 * Formspree is a form-to-email service, not a JSON sink: it emails each
 * top-level key as a labelled row and ignores nesting. So the nested payload is
 * flattened, and a readable `message` digest is included because that is the
 * field Formspree renders as the body of the notification email.
 */
export function buildFormspreePayload(payload) {
  const lead = payload.lead ?? {};
  const context = payload.context ?? {};
  const who = lead.name || lead.email || 'unknown visitor';
  const what = lead.service_interest || 'general enquiry';
  const kind = payload.event === 'lead.escalated' ? 'Escalation' : payload.event === 'lead.updated' ? 'Lead update' : 'New lead';

  const rows = Object.entries(LABELS)
    .filter(([field]) => lead[field])
    .map(([field, label]) => `${label}: ${lead[field]}`);

  const transcript = (payload.transcript ?? [])
    .map((message) => `${message.role === 'user' ? 'Visitor' : 'Hive'}: ${message.content}`)
    .join('\n\n');

  const flat = {
    // Formspree reads `email` as the reply-to address for the notification.
    email: lead.email ?? '',
    name: lead.name ?? '',
    _subject: clamp(`${kind}: ${what} — ${who} [${payload.reference}]`, 200),
    message: clamp(
      [
        `${kind} from the website chatbot.`,
        payload.summary ? `\nSummary: ${payload.summary}` : '',
        `\n${rows.join('\n')}`,
        `\nReference: ${payload.reference}`,
        `Submitted: ${payload.submitted_at}`,
        context.page_url ? `Page: ${context.page_url}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    event: payload.event,
    reference: payload.reference,
    submitted_at: payload.submitted_at,
    source: payload.source,
    ...Object.fromEntries(
      Object.keys(LABELS)
        .filter((field) => field !== 'name' && field !== 'email' && lead[field])
        .map((field) => [field, clamp(lead[field])]),
    ),
    page_url: context.page_url ?? '',
    referrer: context.referrer ?? '',
    session_id: payload.session?.id ?? '',
    message_count: String(payload.session?.message_count ?? 0),
    transcript: clamp(transcript, 8000),
  };

  if (payload.escalation) {
    flat.escalation_reason = clamp(payload.escalation.reason ?? '');
    flat.escalation_urgency = payload.escalation.urgency ?? 'normal';
  }
  if (payload.summary) flat.summary = clamp(payload.summary);
  if (payload.updated_fields) flat.updated_fields = payload.updated_fields.join(', ');

  // Formspree treats empty strings as missing fields in its own validation.
  return Object.fromEntries(Object.entries(flat).filter(([, value]) => value !== ''));
}

/** Every destination the lead should reach, deduplicated by URL. */
function destinations({ url, formspreeUrl } = {}) {
  const generic = url === undefined ? config.webhook.url : url;
  const formspree = formspreeUrl === undefined ? config.webhook.formspreeUrl : formspreeUrl;
  const out = [];
  if (generic) out.push({ name: isFormspreeUrl(generic) ? 'formspree' : 'webhook', url: generic });
  if (formspree && formspree !== generic) out.push({ name: 'formspree', url: formspree });
  return out;
}

/** POSTs one payload to one destination, with exponential backoff. */
async function post(destination, payload) {
  const formspree = destination.name === 'formspree' || isFormspreeUrl(destination.url);
  const rawBody = JSON.stringify(formspree ? buildFormspreePayload(payload) : payload);
  const signature = signPayload(rawBody);
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, config.webhook.maxRetries); attempt += 1) {
    try {
      const response = await fetch(destination.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Without this Formspree answers with a 302 to its thank-you page.
          accept: 'application/json',
          'user-agent': `${config.company.name}-chatbot/1.0`,
          'x-neohives-event': payload.event,
          'x-neohives-timestamp': String(Date.now()),
          ...(signature ? { 'x-neohives-signature': signature } : {}),
        },
        body: rawBody,
        signal: AbortSignal.timeout(config.webhook.timeoutMs),
      });

      if (response.ok) {
        logger.info(
          { reference: payload.reference, destination: destination.name, attempt, status: response.status },
          'lead delivered',
        );
        return { ok: true, status: response.status };
      }

      // Formspree explains a rejected submission in the body; without it a 4xx
      // is impossible to debug (wrong form id, disabled form, spam block).
      const detail = await response.text().catch(() => '');
      lastError = new Error(`${destination.name} responded ${response.status}${detail ? `: ${clamp(detail, 300)}` : ''}`);
      if (!RETRYABLE_STATUS.has(response.status)) break;
    } catch (err) {
      lastError = err;
    }

    if (attempt < config.webhook.maxRetries) {
      const backoff = 400 * 2 ** (attempt - 1);
      logger.warn(
        { destination: destination.name, attempt, backoff, err: lastError?.message },
        'webhook delivery failed — retrying',
      );
      await sleep(backoff);
    }
  }

  return { ok: false, error: lastError?.message ?? 'delivery failed' };
}

/**
 * Delivers a payload to every configured destination (the generic JSON webhook
 * and/or Formspree) with exponential backoff. Every payload is appended to
 * data/leads.jsonl first, so a lead is never lost even if both are down.
 *
 * @returns delivery: 'delivered' (all ok) | 'partial' | 'queued' (all failed)
 *          | 'skipped' (nothing configured)
 */
export async function deliver(payload, options = {}) {
  await appendJsonl(LEAD_LOG, payload);

  const targets = destinations(options);
  if (!targets.length) {
    logger.warn(
      { reference: payload.reference },
      'no LEAD_WEBHOOK_URL or NEXT_PUBLIC_FORMSPREE_WEBHOOK set — lead saved locally only',
    );
    return { ok: true, delivery: 'skipped', reference: payload.reference };
  }

  const results = await Promise.all(
    targets.map(async (destination) => ({ destination: destination.name, ...(await post(destination, payload)) })),
  );

  const failed = results.filter((result) => !result.ok);
  const delivery = failed.length === 0 ? 'delivered' : failed.length === results.length ? 'queued' : 'partial';

  if (failed.length) {
    logger.error(
      { reference: payload.reference, failed: failed.map((f) => `${f.destination}: ${f.error}`) },
      'webhook delivery failed permanently',
    );
    await appendJsonl(DEAD_LETTER, {
      failed_at: new Date().toISOString(),
      destinations: failed.map((f) => f.destination),
      error: failed.map((f) => f.error).join('; '),
      payload,
    });
  }

  // The lead itself is safe on disk, so the caller can still hand the visitor a
  // reference; `delivery` tells ops whether a manual replay is needed.
  return {
    ok: true,
    delivery,
    reference: payload.reference,
    results,
    ...(failed.length ? { error: failed.map((f) => f.error).join('; ') } : {}),
  };
}
