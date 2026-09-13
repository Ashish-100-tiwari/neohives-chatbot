import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Stateless conversation memory.
 *
 * The whole conversation (history + captured lead) is handed back to the browser
 * as one opaque, HMAC-signed, deflated string. The browser keeps it in
 * localStorage and returns it on the next turn. The server stores nothing, so it
 * restarts and scales horizontally for free.
 *
 * Signing matters: without it the client could forge assistant turns, fake tool
 * results, or rewrite the captured lead before it reaches the webhook.
 */
const VERSION = 'nhc1';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function sign(payloadSegment) {
  return createHmac('sha256', config.conversation.secret).update(payloadSegment).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

const nowIso = () => new Date().toISOString();

export function createConversation(origin = {}) {
  return {
    id: randomUUID(),
    createdAt: nowIso(),
    turns: 0,
    messages: [],
    lead: {},
    submissions: [],
    escalations: [],
    // First-touch attribution, persisted for the life of the conversation.
    origin: {
      pageUrl: origin.pageUrl ?? null,
      referrer: origin.referrer ?? null,
      locale: origin.locale ?? null,
      utm: origin.utm ?? null,
    },
    // Per-request only; never written into the state blob.
    request: {},
  };
}

export function encodeState(conversation) {
  const { request, ...persisted } = conversation;
  const payload = b64url(deflateRawSync(Buffer.from(JSON.stringify(persisted), 'utf8')));
  return `${VERSION}.${payload}.${sign(payload)}`;
}

/**
 * @returns {{status: 'new'|'resumed'|'invalid'|'too_large'|'turn_limit', conversation: object}}
 * An unreadable or tampered blob is not an error the visitor can fix, so we
 * start a fresh conversation instead of failing the request.
 */
export function decodeState(raw, origin = {}) {
  if (!raw) return { status: 'new', conversation: createConversation(origin) };

  if (raw.length > config.conversation.maxStateBytes) {
    logger.warn({ bytes: raw.length }, 'conversation state exceeded size limit — starting fresh');
    return { status: 'too_large', conversation: createConversation(origin) };
  }

  const [version, payload, signature] = String(raw).split('.');
  if (version !== VERSION || !payload || !signature || !safeEqual(sign(payload), signature)) {
    logger.warn({ version }, 'conversation state failed signature check — starting fresh');
    return { status: 'invalid', conversation: createConversation(origin) };
  }

  let parsed;
  try {
    parsed = JSON.parse(inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'conversation state could not be decoded — starting fresh');
    return { status: 'invalid', conversation: createConversation(origin) };
  }

  if (!Array.isArray(parsed.messages) || typeof parsed.lead !== 'object' || parsed.lead === null) {
    return { status: 'invalid', conversation: createConversation(origin) };
  }

  const conversation = {
    ...createConversation(origin),
    ...parsed,
    origin: { ...createConversation(origin).origin, ...(parsed.origin ?? {}) },
    submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
    escalations: Array.isArray(parsed.escalations) ? parsed.escalations : [],
    turns: Number.isFinite(parsed.turns) ? parsed.turns : 0,
    request: {},
  };

  if (conversation.turns >= config.conversation.maxTurns) {
    return { status: 'turn_limit', conversation };
  }
  return { status: 'resumed', conversation };
}

export function appendMessages(conversation, messages) {
  for (const message of messages) {
    conversation.messages.push({ ...message, at: message.at ?? nowIso() });
  }
  trimHistory(conversation);
  return conversation;
}

export function mergeLead(conversation, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    conversation.lead[key] = value;
  }
  return conversation.lead;
}

/**
 * Keeps history bounded. Cuts only at a message that can legally start a
 * request — an assistant `tool_calls` message must keep its `tool` replies, and
 * a `tool` message must keep its originating assistant message.
 */
function trimHistory(conversation) {
  const max = config.conversation.maxHistoryMessages;
  if (conversation.messages.length <= max) return;
  let start = conversation.messages.length - max;
  while (start < conversation.messages.length) {
    const message = conversation.messages[start];
    const isSafeStart =
      message.role === 'user' || (message.role === 'assistant' && !message.tool_calls?.length);
    if (isSafeStart) break;
    start += 1;
  }
  conversation.messages = conversation.messages.slice(start);
}

/** Messages in the shape the OpenAI API expects (drops our `at` bookkeeping). */
export function toApiMessages(conversation) {
  return conversation.messages.map(({ at, ...message }) => message);
}

/** Plain transcript for the UI and for the webhook payload. */
export function toTranscript(conversation) {
  return conversation.messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content)
    .map((message) => ({ role: message.role, content: message.content, at: message.at }));
}
