import { Router } from 'express';
import { z } from 'zod';
import { runTurn } from '../agent/runner.js';
import { decodeState, encodeState, toTranscript } from '../services/conversation.js';
import { missingRequiredFields } from '../services/leadSchema.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const apiRouter = Router();

const requestSchema = z.object({
  message: z.string().min(1, 'message is required').max(4000, 'message is too long'),
  // Opaque signed blob from the previous response. Omit it on the first turn.
  state: z.string().max(200_000).optional(),
  stream: z.boolean().optional(),
  pageUrl: z.string().max(500).optional(),
  referrer: z.string().max(500).optional(),
  locale: z.string().max(20).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
});

function firstTouch(req, body) {
  return {
    pageUrl: body.pageUrl ?? null,
    referrer: body.referrer ?? req.get('referer') ?? null,
    locale: body.locale ?? req.get('accept-language')?.split(',')[0] ?? null,
    utm: body.utm ?? null,
  };
}

/** Everything the browser needs to render and to resume the conversation. */
function responseBody(conversation, { reply, toolsUsed, stateStatus }) {
  return {
    reply,
    state: encodeState(conversation),
    conversationId: conversation.id,
    turns: conversation.turns,
    lead: conversation.lead,
    missingFields: missingRequiredFields(conversation.lead),
    // Only the three fields the widget renders — `trigger`/`sentFields`/`updates`
    // are internal bookkeeping and stay in the (opaque) state blob.
    submitted: conversation.submissions[0]
      ? {
          reference: conversation.submissions[0].reference,
          at: conversation.submissions[0].at,
          delivery: conversation.submissions[0].delivery,
        }
      : null,
    escalated: conversation.escalations.length > 0,
    toolsUsed,
    stateStatus,
    // Readable history, so the frontend can repaint the thread after a reload
    // without having to decode the (opaque) state blob.
    transcript: toTranscript(conversation),
  };
}

/**
 * The one and only endpoint.
 *
 *   POST /api/chat
 *   Authorization: Bearer <frontend token>
 *   { "message": "...", "state": "<blob from the last response>" }
 *
 * Set `stream: true` (or send `Accept: text/event-stream`) for token-by-token
 * SSE; otherwise you get a single JSON response.
 */
apiRouter.post('/chat', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_request',
      details: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
    });
  }

  const { message, state, stream } = parsed.data;
  const { status, conversation } = decodeState(state, firstTouch(req, parsed.data));
  conversation.request = { ip: req.ip, userAgent: req.get('user-agent') ?? null };

  if (status === 'turn_limit') {
    return res.status(429).json({
      error: 'conversation_limit',
      reply: `We've covered a lot here — email the ${config.company.shortName} team at ${config.company.contactEmail} and they'll pick it up directly.`,
      state: encodeState(conversation),
      turns: conversation.turns,
    });
  }

  const wantsStream = stream === true || req.get('accept')?.includes('text/event-stream');

  if (!wantsStream) {
    try {
      const result = await runTurn({ conversation, message });
      logger.info(
        { conversationId: conversation.id, turns: conversation.turns, tools: result.toolsUsed, stateStatus: status },
        'chat turn completed',
      );
      return res.json(responseBody(conversation, { ...result, stateStatus: status }));
    } catch (err) {
      logger.error({ err, conversationId: conversation.id }, 'chat turn failed');
      return res.status(502).json({
        error: 'assistant_unavailable',
        message: `Something went wrong on our side. Please try again, or email ${config.company.contactEmail}.`,
        // Hand the state back unchanged so the visitor doesn't lose the thread.
        state: encodeState(conversation),
      });
    }
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on('aborted', () => {
    aborted = true;
  });

  send('start', { conversationId: conversation.id, stateStatus: status });

  try {
    const result = await runTurn({
      conversation,
      message,
      onToken: (token) => !aborted && send('token', { token }),
      onToolStart: (name) => !aborted && send('tool', { name }),
    });
    logger.info(
      { conversationId: conversation.id, turns: conversation.turns, tools: result.toolsUsed, stateStatus: status },
      'chat turn completed (stream)',
    );
    send('done', responseBody(conversation, { ...result, stateStatus: status }));
  } catch (err) {
    logger.error({ err, conversationId: conversation.id }, 'chat turn failed (stream)');
    send('error', {
      error: 'assistant_unavailable',
      message: `Something went wrong on our side. Please try again, or email ${config.company.contactEmail}.`,
      state: encodeState(conversation),
    });
  } finally {
    res.end();
  }
});
