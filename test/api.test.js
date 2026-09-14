import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

// The webhook receiver has to exist before config.js reads the environment, so
// everything below is wired up with dynamic imports.
const received = [];
let receiver;
let server;
let baseUrl;
let verifySignature;
let mintToken;
let token;
let contactEmail;

const SECRET = 'test-secret';
const JWT_SECRET = 'test-jwt-secret-that-is-long-enough-32';

before(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, raw: body, json: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');

  process.env.MOCK_LLM = 'true';
  process.env.OPENAI_API_KEY = '';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.LEAD_WEBHOOK_URL = `http://127.0.0.1:${receiver.address().port}/hook`;
  process.env.LEAD_WEBHOOK_SECRET = SECRET;
  // Explicitly blank so a populated .env can never post test leads to the real
  // Formspree form (dotenv does not overwrite keys that are already present).
  process.env.NEXT_PUBLIC_FORMSPREE_WEBHOOK = '';
  process.env.FORMSPREE_WEBHOOK = '';
  process.env.WEBHOOK_MAX_LEAD_UPDATES = '3';
  process.env.RATE_LIMIT_MAX = '1000';
  process.env.MAX_TURNS_PER_CONVERSATION = '4';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';

  ({ verifySignature } = await import('../src/services/webhook.js'));
  ({ mintToken } = await import('../src/auth/token.js'));
  const { assertConfig, config } = await import('../src/config.js');
  assertConfig();
  contactEmail = config.company.contactEmail;
  token = mintToken().token;

  const { createApp } = await import('../src/app.js');
  server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  receiver?.close();
});

const chat = (body, { auth = token, headers = {} } = {}) =>
  fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe('auth', () => {
  it('mints a token with no expiry', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    assert.equal(claims.exp, undefined);
    assert.equal(claims.iss, 'neohives.com');
    assert.equal(claims.aud, 'neohives-chatbot');
    assert.match(claims.jti, /^[0-9a-f-]{36}$/);
  });

  it('rejects a missing token', async () => {
    const res = await chat({ message: 'hi' }, { auth: null });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'missing_token');
    assert.match(res.headers.get('www-authenticate'), /Bearer/);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign({ scope: 'chat' }, 'not-the-secret', {
      issuer: 'neohives.com',
      audience: 'neohives-chatbot',
    });
    const res = await chat({ message: 'hi' }, { auth: forged });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'invalid_token');
  });

  it('rejects the alg=none downgrade', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ iss: 'neohives.com', aud: 'neohives-chatbot', scope: 'chat' }),
    ).toString('base64url');
    const res = await chat({ message: 'hi' }, { auth: `${header}.${body}.` });
    assert.equal(res.status, 401);
  });

  it('rejects a token for another audience', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const other = jwt.sign({ scope: 'chat' }, JWT_SECRET, { issuer: 'neohives.com', audience: 'someone-else' });
    const res = await chat({ message: 'hi' }, { auth: other });
    assert.equal(res.status, 401);
  });

  it('leaves the health probe open', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('exposes no other API endpoint', async () => {
    for (const path of ['/api/session', '/api/leads', '/api/knowledge', '/api/health']) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{}',
      });
      assert.equal(res.status, 404, `${path} should not exist`);
    }
  });
});

describe('chat', () => {
  it('rejects an empty message', async () => {
    const res = await chat({ message: '' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_request');
  });

  it('answers a first turn and returns a state blob', async () => {
    const body = await chat({ message: 'What does a website cost?', pageUrl: 'https://neohives.com/pricing' }).then(
      (r) => r.json(),
    );
    assert.ok(body.toolsUsed.includes('get_pricing'));
    assert.ok(body.reply.length > 0);
    assert.match(body.state, /^nhc1\./);
    assert.equal(body.stateStatus, 'new');
    assert.equal(body.turns, 1);
    assert.deepEqual(body.missingFields, ['email', 'service_interest']);
    assert.equal(body.transcript.length, 2);
  });

  it('resumes memory from the state blob the client sends back', async () => {
    const first = await chat({ message: 'How do we get started?' }).then((r) => r.json());
    const second = await chat({
      message: 'my email is priya@acme.io and I need an internal dashboard',
      state: first.state,
    }).then((r) => r.json());

    assert.equal(second.stateStatus, 'resumed');
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(second.turns, 2);
    assert.equal(second.lead.email, 'priya@acme.io');
    assert.ok(!second.missingFields.includes('email'));
    assert.equal(second.transcript.filter((m) => m.role === 'user').length, 2);
  });

  it('starts fresh when the state blob has been tampered with', async () => {
    const first = await chat({ message: 'my email is priya@acme.io' }).then((r) => r.json());
    const [version, payload] = first.state.split('.');

    // Re-sign with the wrong key: a client cannot forge history or lead data.
    const { createHmac } = await import('node:crypto');
    const forged = `${version}.${payload}.${createHmac('sha256', 'wrong').update(payload).digest('base64url')}`;

    const second = await chat({ message: 'hello again', state: forged }).then((r) => r.json());
    assert.equal(second.stateStatus, 'invalid');
    assert.equal(second.turns, 1);
    assert.deepEqual(second.lead, {});
    assert.notEqual(second.conversationId, first.conversationId);
  });

  it('starts fresh on a garbage state blob instead of erroring', async () => {
    const res = await chat({ message: 'hi', state: 'nope' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stateStatus, 'invalid');
  });

  it('enforces the per-conversation turn cap', async () => {
    let state;
    for (let i = 0; i < 4; i += 1) {
      const body = await chat({ message: `question ${i}`, state }).then((r) => r.json());
      state = body.state;
    }
    const res = await chat({ message: 'one more', state });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, 'conversation_limit');
    assert.ok(body.reply.includes(contactEmail), `expected the reply to offer ${contactEmail}`);
  });

  it('reports a submission over the wire without leaking internal bookkeeping', async () => {
    received.length = 0;
    const body = await chat({
      message: 'we want a customer dashboard, my email is wire@acme.io',
    }).then((r) => r.json());

    assert.ok(body.toolsUsed.includes('update_lead'));
    assert.deepEqual(Object.keys(body.submitted).sort(), ['at', 'delivery', 'reference']);
    assert.match(body.submitted.reference, /^NH-\d{6}-[0-9A-F]{6}$/);
    assert.deepEqual(body.missingFields, []);
    assert.equal(received.length, 1);
  });

  it('streams the same turn over SSE', async () => {
    const res = await chat({ message: 'hello there', stream: true });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: token/);
    assert.match(text, /event: done/);
    const done = JSON.parse(text.split('event: done\ndata: ')[1].split('\n\n')[0]);
    assert.match(done.state, /^nhc1\./);
  });
});

describe('lead submission', () => {
  /** Drives the tools directly — the mock model won't volunteer a submission. */
  const submitVia = async (lead) => {
    const { createConversation, mergeLead } = await import('../src/services/conversation.js');
    const { runTool } = await import('../src/agent/tools.js');
    const conversation = createConversation({ pageUrl: 'https://neohives.com/pricing' });
    mergeLead(conversation, lead);
    return {
      conversation,
      result: await runTool('submit_lead', { summary: 'Wants a portal.' }, { conversation }),
    };
  };

  /** The real path: fields arrive through update_lead, which submits by itself. */
  const captureVia = async (...updates) => {
    const { createConversation } = await import('../src/services/conversation.js');
    const { runTool } = await import('../src/agent/tools.js');
    const conversation = createConversation({ pageUrl: 'https://neohives.com/pricing' });
    const results = [];
    for (const fields of updates) {
      results.push(await runTool('update_lead', fields, { conversation }));
    }
    return { conversation, results, result: results.at(-1) };
  };

  it('refuses to submit an incomplete lead', async () => {
    const { result } = await submitVia({ name: 'Sam' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['email', 'service_interest']);
  });

  it('does not submit on an email alone', async () => {
    received.length = 0;
    const { result } = await captureVia({ name: 'Sam', email: 'sam@acme.io' });
    assert.equal(result.ready_to_submit, false);
    assert.deepEqual(result.still_missing, ['service_interest']);
    assert.equal(result.auto_submitted, undefined);
    assert.equal(received.length, 0, 'webhook must not fire without a service interest');
  });

  it('does not submit on a service interest alone', async () => {
    received.length = 0;
    const { result } = await captureVia({ service_interest: 'Web development' });
    assert.equal(result.ready_to_submit, false);
    assert.deepEqual(result.still_missing, ['email']);
    assert.equal(received.length, 0, 'webhook must not fire without an email');
  });

  it('does not submit on an unparseable email', async () => {
    received.length = 0;
    const { result } = await captureVia({ email: 'sam at acme dot io', service_interest: 'Voice AI' });
    assert.equal(result.ok, false, 'the invalid email should be rejected outright');
    assert.equal(received.length, 0);
  });

  it('submits automatically as soon as it has an email and a service', async () => {
    received.length = 0;
    const { result, conversation } = await captureVia({
      name: 'Auto Rao',
      email: 'auto@acme.io',
      service_interest: 'AI agents & automation',
    });

    assert.equal(result.ready_to_submit, true);
    assert.equal(result.auto_submitted.ok, true);
    assert.equal(result.auto_submitted.delivery, 'delivered');
    assert.match(result.auto_submitted.reference, /^NH-\d{6}-[0-9A-F]{6}$/);
    assert.equal(conversation.submissions.length, 1);
    assert.equal(conversation.submissions[0].trigger, 'auto');

    assert.equal(received.length, 1);
    assert.equal(received[0].json.event, 'lead.submitted');
    assert.equal(received[0].json.lead.email, 'auto@acme.io');
    assert.equal(received[0].json.lead.service_interest, 'AI agents & automation');
  });

  it('forwards detail learned after the first submission as an update', async () => {
    received.length = 0;
    const { results } = await captureVia(
      { email: 'later@acme.io', service_interest: 'Private RAG / document AI' },
      { budget_range: '$15k', timeline: 'next quarter' },
    );

    const reference = results[0].auto_submitted.reference;
    assert.deepEqual(results[1].forwarded_update.updated_fields, ['budget_range', 'timeline']);
    assert.equal(results[1].forwarded_update.reference, reference, 'updates reuse the original reference');

    assert.equal(received.length, 2);
    assert.equal(received[1].json.event, 'lead.updated');
    assert.equal(received[1].json.reference, reference);
    assert.equal(received[1].json.lead.budget_range, '$15k');
  });

  it('sends no update when nothing new was learned', async () => {
    received.length = 0;
    const { results } = await captureVia(
      { email: 'same@acme.io', service_interest: 'Mobile app development' },
      { email: 'same@acme.io' },
    );
    assert.equal(results[1].forwarded_update, undefined);
    assert.equal(received.length, 1);
  });

  it('caps follow-up updates per conversation', async () => {
    received.length = 0;
    const { config } = await import('../src/config.js');
    await captureVia(
      { email: 'chatty@acme.io', service_interest: 'Cloud engineering' },
      { phone: '+91 90000 00001' },
      { company: 'Acme' },
      { country: 'India' },
      { industry: 'Logistics' },
      { timeline: 'Q3' },
    );
    assert.equal(received.length, 1 + config.webhook.maxLeadUpdates);
  });

  it('delivers a signed payload to the webhook', async () => {
    received.length = 0;
    const { result } = await submitVia({
      name: 'Sam Rao',
      email: 'sam@acme.io',
      phone: '+91 90000 00000',
      company: 'Acme',
      service_interest: 'Web development',
      requirement: 'Client portal with billing',
      budget_range: '2-3 lakh',
    });

    assert.equal(result.ok, true);
    assert.equal(result.delivery, 'delivered');
    assert.match(result.reference, /^NH-\d{6}-[0-9A-F]{6}$/);
    assert.equal(received.length, 1);

    const delivery = received[0];
    assert.equal(delivery.json.event, 'lead.submitted');
    assert.equal(delivery.json.lead.email, 'sam@acme.io');
    assert.equal(delivery.json.context.page_url, 'https://neohives.com/pricing');
    assert.ok(verifySignature(delivery.raw, delivery.headers['x-neohives-signature'], SECRET));
    assert.equal(verifySignature(delivery.raw, delivery.headers['x-neohives-signature'], 'wrong-secret'), false);
  });

  it('does not re-send a replayed conversation state', async () => {
    received.length = 0;
    const lead = { name: 'Replay Test', email: 'replay@acme.io', service_interest: 'QA & testing' };
    const first = await submitVia(lead);
    const second = await submitVia(lead); // fresh conversation, identical lead
    assert.equal(received.length, 1, 'webhook should fire only once');
    assert.equal(second.result.already_submitted, true);
    assert.equal(second.result.reference, first.result.reference);
  });

  it('is idempotent when submit_lead follows an automatic submission', async () => {
    received.length = 0;
    const { createConversation } = await import('../src/services/conversation.js');
    const { runTool } = await import('../src/agent/tools.js');
    const conversation = createConversation();
    const auto = await runTool(
      'update_lead',
      { email: 'idem@acme.io', service_interest: 'UI/UX design' },
      { conversation },
    );
    const explicit = await runTool('submit_lead', { summary: 'Redesign of the marketing site.' }, { conversation });

    assert.equal(explicit.already_submitted, true);
    assert.equal(explicit.reference, auto.auto_submitted.reference);
    assert.equal(conversation.submissions.length, 1);
    // One submission plus one update carrying the summary — never a second lead.
    assert.equal(received.length, 2);
    assert.equal(received[1].json.event, 'lead.updated');
    assert.match(received[1].json.lead.notes, /Redesign of the marketing site/);
  });
});

describe('formspree payload', () => {
  const build = async (payload) => {
    const { buildFormspreePayload, buildPayload } = await import('../src/services/webhook.js');
    return buildFormspreePayload(buildPayload(payload));
  };

  it('recognises a formspree endpoint', async () => {
    const { isFormspreeUrl } = await import('../src/services/webhook.js');
    assert.equal(isFormspreeUrl('https://formspree.io/f/myeyjqpa'), true);
    assert.equal(isFormspreeUrl('https://formspree.io.evil.test/f/x'), false);
    assert.equal(isFormspreeUrl('http://127.0.0.1:4010/hook'), false);
    assert.equal(isFormspreeUrl('not a url'), false);
  });

  it('flattens the lead into form fields with a readable message', async () => {
    const flat = await build({
      event: 'lead.submitted',
      reference: 'NH-260914-ABCDEF',
      lead: {
        name: 'Priya N',
        email: 'priya@acme.io',
        service_interest: 'Voice AI',
        requirement: 'Automate inbound support calls',
        budget_range: '$20k',
      },
      conversation: { id: 'c1', origin: { pageUrl: 'https://neohives.com/pricing' } },
      transcript: [{ role: 'user', content: 'We get 400 calls a day' }],
      extra: { summary: 'Inbound voice agent for support.' },
    });

    // Formspree uses `email` as the reply-to address, so it must stay top level.
    assert.equal(flat.email, 'priya@acme.io');
    assert.equal(flat.name, 'Priya N');
    assert.equal(flat.service_interest, 'Voice AI');
    assert.equal(flat.budget_range, '$20k');
    assert.equal(flat.reference, 'NH-260914-ABCDEF');
    assert.equal(flat.page_url, 'https://neohives.com/pricing');
    assert.match(flat._subject, /New lead: Voice AI — Priya N \[NH-260914-ABCDEF\]/);
    assert.match(flat.message, /Requirement: Automate inbound support calls/);
    assert.match(flat.message, /Inbound voice agent for support\./);
    assert.match(flat.transcript, /Visitor: We get 400 calls a day/);

    // Nested objects would be dropped by Formspree, and blanks read as missing.
    for (const [key, value] of Object.entries(flat)) {
      assert.equal(typeof value, 'string', `${key} must be a string`);
      assert.notEqual(value, '', `${key} must not be blank`);
    }
  });

  it('clamps a long transcript so formspree accepts the submission', async () => {
    const flat = await build({
      event: 'lead.submitted',
      reference: 'NH-260914-000001',
      lead: { email: 'big@acme.io', service_interest: 'Web development', notes: 'x'.repeat(20_000) },
      transcript: Array.from({ length: 200 }, () => ({ role: 'user', content: 'y'.repeat(500) })),
    });
    assert.ok(flat.transcript.length <= 8000, `transcript was ${flat.transcript.length} chars`);
    assert.ok(flat.notes.length <= 4000, `notes was ${flat.notes.length} chars`);
  });

  it('labels an escalation differently', async () => {
    const flat = await build({
      event: 'lead.escalated',
      reference: 'NH-ESC-260914-ABCDEF',
      lead: { email: 'legal@acme.io', service_interest: 'IT consulting' },
      extra: { escalation: { reason: 'Wants a DPA review', urgency: 'high' } },
    });
    assert.match(flat._subject, /^Escalation:/);
    assert.equal(flat.escalation_reason, 'Wants a DPA review');
    assert.equal(flat.escalation_urgency, 'high');
  });
});
