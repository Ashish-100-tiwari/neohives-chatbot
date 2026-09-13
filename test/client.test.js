/**
 * Exercises examples/neohives-chat.js — the client handed to frontend devs — against
 * a real server, so the documented snippet can't silently rot.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let server;
let apiUrl;
let token;
let createNeohivesChat;
let NeohivesChatError;
let contactEmail;

/** Stand-in for localStorage (Node has no Web Storage by default). */
function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

before(async () => {
  process.env.MOCK_LLM = 'true';
  process.env.OPENAI_API_KEY = '';
  process.env.JWT_SECRET = 'client-test-secret-that-is-long-enough';
  process.env.LEAD_WEBHOOK_URL = '';
  process.env.RATE_LIMIT_MAX = '1000';
  process.env.MAX_TURNS_PER_CONVERSATION = '3';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';

  contactEmail = (await import('../src/config.js')).config.company.contactEmail;
  token = (await import('../src/auth/token.js')).mintToken().token;
  ({ createNeohivesChat, NeohivesChatError } = await import('../examples/neohives-chat.js'));

  const { createApp } = await import('../src/app.js');
  server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const makeChat = (storage = fakeStorage()) => ({
  storage,
  chat: createNeohivesChat({ apiUrl, token, storage, meta: () => ({ pageUrl: 'https://neohives.com/' }) }),
});

describe('example client', () => {
  it('requires apiUrl and token', () => {
    assert.throws(() => createNeohivesChat({ token: 't' }), /apiUrl is required/);
    assert.throws(() => createNeohivesChat({ apiUrl: 'x' }), /token is required/);
  });

  it('sends a turn and persists state + transcript to storage', async () => {
    const { chat, storage } = makeChat();
    const data = await chat.send('What does a website cost?');

    assert.match(data.reply, /\S/);
    assert.equal(data.stateStatus, 'new');
    assert.match(storage.getItem('nh_state'), /^nhc1\./);
    assert.equal(JSON.parse(storage.getItem('nh_transcript')).length, 2);
    assert.equal(chat.history().length, 2);
  });

  it('resumes memory across sends without the caller touching state', async () => {
    const { chat } = makeChat();
    await chat.send('How do we get started?');
    const second = await chat.send('my email is priya@acme.io and I need a dashboard');

    assert.equal(second.stateStatus, 'resumed');
    assert.equal(second.turns, 2);
    assert.equal(second.lead.email, 'priya@acme.io');
    assert.equal(chat.history().filter((m) => m.role === 'user').length, 2);
  });

  it('streams tokens and tool events, then persists the done payload', async () => {
    const { chat, storage } = makeChat();
    const tokens = [];
    const tools = [];
    const data = await chat.send('what is the pricing?', {
      stream: true,
      onToken: (t) => tokens.push(t),
      onTool: (name) => tools.push(name),
    });

    assert.ok(tokens.length > 1, 'expected multiple token deltas');
    assert.deepEqual(tools, ['get_pricing']);
    assert.equal(tokens.join(''), data.reply);
    assert.equal(storage.getItem('nh_state'), data.state);
  });

  it('reset() clears both keys', async () => {
    const { chat, storage } = makeChat();
    await chat.send('hello');
    chat.reset();
    assert.equal(storage.getItem('nh_state'), null);
    assert.equal(storage.getItem('nh_transcript'), null);
    assert.deepEqual(chat.history(), []);
  });

  it('throws a typed error on a bad token', async () => {
    const chat = createNeohivesChat({ apiUrl, token: 'not-a-jwt', storage: fakeStorage() });
    await assert.rejects(
      () => chat.send('hi'),
      (err) => {
        assert.ok(err instanceof NeohivesChatError);
        assert.equal(err.status, 401);
        assert.equal(err.code, 'invalid_token');
        return true;
      },
    );
  });

  it('surfaces the turn cap as a typed error carrying visitor-safe copy', async () => {
    const { chat } = makeChat();
    for (let i = 0; i < 3; i += 1) await chat.send(`question ${i}`);
    await assert.rejects(
      () => chat.send('one more'),
      (err) => {
        assert.equal(err.code, 'conversation_limit');
        assert.equal(err.status, 429);
        assert.ok(err.message.includes(contactEmail), `expected the error copy to offer ${contactEmail}`);
        return true;
      },
    );
  });

  it('survives a storage that throws (Safari private mode)', async () => {
    const hostile = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
      removeItem: () => {},
    };
    const chat = createNeohivesChat({ apiUrl, token, storage: hostile });
    const data = await chat.send('hello');
    assert.match(data.reply, /\S/);
    // Falls back to in-memory storage, so memory still works within the page.
    assert.equal(chat.state, data.state);
  });

  it('recovers from a corrupted stored state by starting fresh', async () => {
    const storage = fakeStorage();
    storage.setItem('nh_state', 'nhc1.garbage.signature');
    const chat = createNeohivesChat({ apiUrl, token, storage });
    const data = await chat.send('hello');
    assert.equal(data.stateStatus, 'invalid');
    assert.equal(data.turns, 1);
  });
});
