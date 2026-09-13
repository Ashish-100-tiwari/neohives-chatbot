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
    assert.deepEqual(body.missingFields, ['name', 'email', 'requirement']);
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
  /** Drives the tools directly — the mock model never confirms a submission itself. */
  const submitVia = async (lead) => {
    const { createConversation, mergeLead } = await import('../src/services/conversation.js');
    const { runTool } = await import('../src/agent/tools.js');
    const conversation = createConversation({ pageUrl: 'https://neohives.com/pricing' });
    mergeLead(conversation, lead);
    return {
      conversation,
      result: await runTool('submit_lead', { confirmed_by_visitor: true, summary: 'Wants a portal.' }, { conversation }),
    };
  };

  it('refuses to submit without visitor confirmation', async () => {
    const { createConversation, mergeLead } = await import('../src/services/conversation.js');
    const { runTool } = await import('../src/agent/tools.js');
    const conversation = createConversation();
    mergeLead(conversation, { name: 'A', email: 'a@b.co', requirement: 'x' });
    const result = await runTool('submit_lead', { confirmed_by_visitor: false, summary: 's' }, { conversation });
    assert.equal(result.ok, false);
    assert.match(result.error, /confirmation/);
  });

  it('refuses to submit an incomplete lead', async () => {
    const { result } = await submitVia({ name: 'Sam' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['email', 'requirement']);
  });

  it('delivers a signed payload to the webhook', async () => {
    received.length = 0;
    const { result } = await submitVia({
      name: 'Sam Rao',
      email: 'sam@acme.io',
      phone: '+91 90000 00000',
      company: 'Acme',
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
    const lead = { name: 'Replay Test', email: 'replay@acme.io', requirement: 'Same enquiry twice' };
    const first = await submitVia(lead);
    const second = await submitVia(lead); // fresh conversation, identical lead
    assert.equal(received.length, 1, 'webhook should fire only once');
    assert.equal(second.result.already_submitted, true);
    assert.equal(second.result.reference, first.result.reference);
  });
});
