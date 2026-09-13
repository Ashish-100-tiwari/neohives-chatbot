/**
 * Neohives chat client — framework-agnostic, zero dependencies, ESM.
 * Copy this file into your frontend (src/lib/neohives-chat.js).
 *
 *   import { createNeohivesChat } from './lib/neohives-chat.js';
 *
 *   const chat = createNeohivesChat({
 *     apiUrl: import.meta.env.VITE_NEOHIVES_API_URL,
 *     token:  import.meta.env.VITE_NEOHIVES_CHAT_TOKEN,
 *   });
 *
 *   const { reply } = await chat.send('What does a website cost?');
 *
 * It owns the two localStorage keys: the opaque signed `state` (the bot's memory)
 * and a readable `transcript` (so you can repaint the thread after a reload).
 */

const DEFAULT_KEYS = { state: 'nh_state', transcript: 'nh_transcript' };

/** The opening line. There is no endpoint for it — render it client-side. */
export const GREETING =
  "Hi — I'm Hive, from Neo Hives IT Solutions. I can help with AI agents and automation, private RAG/document AI, voice AI, web and mobile apps, UI/UX, testing, cloud engineering, IT consulting or digital marketing. What are you looking to build or improve?";

export class NeohivesChatError extends Error {
  constructor(message, { code, status, retryAfter } = {}) {
    super(message);
    this.name = 'NeohivesChatError';
    this.code = code ?? 'unknown_error';
    this.status = status ?? 0;
    this.retryAfter = retryAfter ?? null;
  }
}

/** localStorage can throw (Safari private mode, quota) — degrade to memory. */
function safeStorage(storage) {
  try {
    const probe = '__nh_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    const memory = new Map();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value),
      removeItem: (key) => memory.delete(key),
    };
  }
}

export function createNeohivesChat({
  apiUrl,
  token,
  storage = typeof localStorage === 'undefined' ? undefined : localStorage,
  keys = DEFAULT_KEYS,
  /** Extra context sent with every turn — shows up in the webhook payload. */
  meta = () => ({
    pageUrl: typeof location === 'undefined' ? undefined : location.href,
    locale: typeof navigator === 'undefined' ? undefined : navigator.language,
  }),
} = {}) {
  if (!apiUrl) throw new Error('createNeohivesChat: apiUrl is required');
  if (!token) throw new Error('createNeohivesChat: token is required');

  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/chat`;
  const store = safeStorage(storage ?? { getItem: () => null, setItem: () => {}, removeItem: () => {} });

  const getState = () => store.getItem(keys.state) ?? undefined;

  const persist = (data) => {
    if (data.state) store.setItem(keys.state, data.state);
    if (data.transcript) store.setItem(keys.transcript, JSON.stringify(data.transcript));
  };

  /** Messages already exchanged, for painting the UI on load. */
  function history() {
    try {
      const parsed = JSON.parse(store.getItem(keys.transcript) ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Forget the conversation (wire this to a "clear chat" button). */
  function reset() {
    store.removeItem(keys.state);
    store.removeItem(keys.transcript);
  }

  async function readError(res) {
    const body = await res.json().catch(() => ({}));
    // 429/502 carry a `reply` written for the visitor, and 502 returns the state
    // unchanged so the thread survives a backend hiccup.
    if (body.state) store.setItem(keys.state, body.state);
    return new NeohivesChatError(body.reply ?? body.message ?? `Request failed (${res.status})`, {
      code: body.error,
      status: res.status,
      retryAfter: Number(res.headers.get('retry-after')) || null,
    });
  }

  /**
   * Send one visitor message.
   *
   * @param {string} message
   * @param {object} [options]
   * @param {boolean}  [options.stream]  stream the reply token by token
   * @param {Function} [options.onToken] (token) => void — append to the bubble
   * @param {Function} [options.onTool]  (name) => void — e.g. show "checking pricing…"
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>} the full response body (reply, lead, missingFields, submitted, …)
   */
  async function send(message, { stream = false, onToken, onTool, signal } = {}) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      signal,
      body: JSON.stringify({ message, state: getState(), stream, ...meta() }),
    });

    if (!res.ok) throw await readError(res);

    // The server answers with JSON unless it actually opened a stream.
    const isStream = res.headers.get('content-type')?.includes('text/event-stream');
    if (!isStream || !res.body?.pipeThrough) {
      const data = await res.json();
      persist(data);
      return data;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let result = null;
    let streamError = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      // SSE frames are separated by a blank line.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;

        let data;
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          continue;
        }

        if (event === 'token') onToken?.(data.token);
        else if (event === 'tool') onTool?.(data.name);
        else if (event === 'done') result = data;
        else if (event === 'error') {
          streamError = new NeohivesChatError(data.message, { code: data.error, status: 200 });
          if (data.state) store.setItem(keys.state, data.state);
        }
      }
    }

    if (streamError) throw streamError;
    if (!result) throw new NeohivesChatError('The connection closed before the reply finished.', { code: 'stream_incomplete' });
    persist(result);
    return result;
  }

  return { send, history, reset, get state() { return getState(); }, GREETING };
}
