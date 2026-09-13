# Neohives chatbot — frontend integration guide

Everything you need to put the assistant on the site. **One endpoint, one header, one
localStorage key.**

- **Endpoint:** `POST {API_BASE}/api/chat`
- **Auth:** `Authorization: Bearer <token>` — a permanent JWT, given to you by the
  backend team. Put it in your env file.
- **Memory:** the server stores nothing. Each response returns a `state` string; you
  keep it in `localStorage` and send it back on the next message.

Copy-paste client: [`examples/neohives-chat.js`](../examples/neohives-chat.js) ·
React hook: [`examples/useNeohivesChat.js`](../examples/useNeohivesChat.js) ·
Runnable curl walkthrough: [`examples/curl.sh`](../examples/curl.sh)

---

## 1. What you need from the backend team

| Thing | Example | Notes |
| --- | --- | --- |
| API base URL | `https://chat.neohives.com` | no trailing slash |
| Chat token | `eyJhbGciOiJIUzI1NiIs…` (~275 chars) | never expires; they mint it with `npm run token` |
| Your origins allowlisted | `http://localhost:5173`, `https://neohives.com` | they set `ALLOWED_ORIGINS`; **CORS fails without this** |

```bash
# .env (Vite)
VITE_NEOHIVES_API_URL=https://chat.neohives.com
VITE_NEOHIVES_CHAT_TOKEN=eyJhbGciOiJIUzI1NiIs…

# .env (Next.js)
NEXT_PUBLIC_NEOHIVES_API_URL=https://chat.neohives.com
NEXT_PUBLIC_NEOHIVES_CHAT_TOKEN=eyJhbGciOiJIUzI1NiIs…
```

This token ends up in your JS bundle and is readable in DevTools — that is expected
and by design. It identifies *the website*, not the visitor, so **never treat it as a
secret and never gate anything else with it.** The OpenAI key is not here and must
never be: it lives only on the backend.

---

## 2. The mental model

```
                first message                     later messages
                     │                                  │
POST /api/chat  { message }              POST /api/chat  { message, state }
                     │                                  │
                     ▼                                  ▼
        { reply, state, transcript, … }     { reply, state, transcript, … }
                     │                                  │
        localStorage['nh_state'] = state ────────────────┘   ← the bot's memory
        localStorage['nh_transcript'] = transcript           ← for repainting the UI
```

- Omit `state` and you start a brand-new conversation.
- Send back the **latest** `state` and the bot remembers everything: the thread, the
  visitor's name/email, whether their enquiry has been submitted.
- `state` is opaque and signed. **Don't parse, edit, or hand-build it** — the server
  verifies a signature and will silently start a new conversation if it doesn't match.
  Render your UI from `transcript` instead.

---

## 3. curl quickstart

Set these once:

```bash
export API=http://localhost:3000
export TOKEN='eyJhbGciOiJIUzI1NiIs…'
```

### First message

```bash
curl -sS -X POST "$API/api/chat" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "message": "What does a client portal cost?",
    "pageUrl": "https://neohives.com/pricing",
    "locale":  "en-IN",
    "utm":     { "utm_source": "google", "utm_campaign": "brand" }
  }'
```

Real response (this one is from a server in mock mode — hence the `[mock]` prefix;
with a live OpenAI key the `reply` is a normal sentence and the shape is identical):

```json
{
  "reply": "[mock] Our Starter plan begins at ₹45,000 and Growth at ₹1,25,000 — both are starting points, the final quote follows a short discovery call. What are you looking to build?",
  "state": "nhc1.nVjtbhu7EX2VAYEEucgqXsmWE-t…",
  "conversationId": "195d39d6-5c4a-4a01-b0e5-87090b036f42",
  "turns": 1,
  "lead": {},
  "missingFields": ["name", "email", "requirement"],
  "submitted": null,
  "escalated": false,
  "toolsUsed": ["get_pricing"],
  "stateStatus": "new",
  "transcript": [
    { "role": "user", "content": "What does a client portal cost?", "at": "2026-09-12T10:19:27.030Z" },
    { "role": "assistant", "content": "[mock] Our Starter plan begins at ₹45,000 …", "at": "2026-09-12T10:19:27.031Z" }
  ]
}
```

### Follow-up message (with memory)

The state blob is long, so build the body in a file rather than fighting your shell:

```bash
# save the state from the previous response
echo '<the state value>' > /tmp/state.txt

node -e 'require("fs").writeFileSync("/tmp/body.json", JSON.stringify({
  message: "I am Sam from Acme, my email is sam@acme.io, I need a booking portal",
  state: require("fs").readFileSync("/tmp/state.txt","utf8").trim()
}))'

curl -sS -X POST "$API/api/chat" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d @/tmp/body.json
```

```json
{
  "reply": "[mock] Got it, thanks. Could you tell me your name and the company you represent?",
  "turns": 2,
  "stateStatus": "resumed",
  "lead": { "email": "sam@acme.io", "requirement": "I am Sam from Acme, … I need a booking portal" },
  "missingFields": ["name"],
  "submitted": null
}
```

`stateStatus: "resumed"` and the growing `turns` confirm the memory round-trip worked.

### Streaming

```bash
curl -sS -N -X POST "$API/api/chat" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"message":"How do we get started?","stream":true}'
```

```
event: start
data: {"conversationId":"f03353bd-3b01-4260-98b8-2806f882db9d","stateStatus":"new"}

event: tool
data: {"name":"get_onboarding"}

event: token
data: {"token":"Onboarding "}

event: token
data: {"token":"is: "}

…

event: done
data: {"reply":"Onboarding is: …","state":"nhc1.…","turns":1,"lead":{},…}
```

### The whole flow, scripted

```bash
export NEOHIVES_API=$API NEOHIVES_TOKEN=$TOKEN
bash examples/curl.sh
```

---

## 4. Request contract

`POST /api/chat`, `content-type: application/json`, `authorization: Bearer <token>`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `message` | string | **yes** | 1–4000 chars. The visitor's message. |
| `state` | string | no | The `state` from the previous response. Omit to start fresh. |
| `stream` | boolean | no | `true` → SSE. (Or send `Accept: text/event-stream`.) |
| `pageUrl` | string | no | Which page they're on. Sent to sales as first-touch attribution. |
| `referrer` | string | no | Defaults to the `Referer` header. |
| `locale` | string | no | e.g. `navigator.language`. Helps the bot mirror their language. |
| `utm` | object | no | Flat string→string map. Captured with the lead. |

`pageUrl`, `referrer`, `locale` and `utm` are only recorded on the **first** turn of a
conversation, but it's harmless to send them every time (the client does).

## 5. Response contract

| Field | Type | Use it for |
| --- | --- | --- |
| `reply` | string | The assistant's message. Render as text (light markdown at most). |
| `state` | string | **Save to localStorage, send back next turn.** Opaque. |
| `transcript` | array | `{role, content, at}[]` — repaint the thread after a page reload. |
| `conversationId` | string | Logging / support ("my chat id is…"). |
| `turns` | number | How many visitor messages so far. Cap is 40 (see `conversation_limit`). |
| `lead` | object | What's been captured: `name`, `email`, `phone`, `company`, `service_interest`, `requirement`, `budget_range`, `timeline`, `preferred_contact_time`, `notes`. All optional. |
| `missingFields` | array | Which of `name`/`email`/`requirement` are still needed. Informational — the bot asks for them itself. |
| `submitted` | object\|null | `{ reference, at, delivery }` once the enquiry has been sent to the team. Show the `reference`. |
| `escalated` | boolean | A human has been flagged for this conversation. |
| `toolsUsed` | array | Which tools ran this turn. Debugging/analytics. |
| `stateStatus` | string | `new` \| `resumed` \| `invalid` \| `too_large` — see below. |

### `stateStatus`

| Value | Meaning | What to do |
| --- | --- | --- |
| `new` | No state was sent; fresh conversation. | Nothing. |
| `resumed` | State verified, memory intact. | Nothing. |
| `invalid` | State was corrupt, truncated or tampered with — the server started over. | Optional: clear your saved transcript so the UI matches the bot's memory. |
| `too_large` | State exceeded the size cap; started over. | Same. Shouldn't happen in practice. |

The server never errors on a bad `state` — it just begins a new conversation. If you
see `invalid` unexpectedly, you're probably storing a stale or mangled blob.

## 6. Errors

Every error body has `error` (a stable machine code) and usually `message` and/or
`reply`. **When `reply` is present it is visitor-safe copy — show it in the bubble.**

| Status | `error` | Meaning | Handling |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Bad/missing field; see `details[]`. | Bug in your code. |
| 400 | `invalid_json` | Malformed body. | Bug in your code. |
| 401 | `missing_token` | No `Authorization` header. | Check your env var is actually inlined at build time. |
| 401 | `invalid_token` | Wrong/garbled token, or the secret was rotated. | Get a fresh token from the backend team. |
| 401 | `revoked_token` | The token was revoked. | Same. |
| 413 | `payload_too_large` | Body over 256 KB. | Your `state` is bloated — clear it. |
| 429 | `rate_limited` | Too many requests from this IP (default 20/min). | Show `reply`, disable the input briefly. Honour `Retry-After` if set. |
| 429 | `conversation_limit` | This conversation hit the 40-turn cap. | Show `reply` (it points them at email) and offer a "start over" button that clears `nh_state`. |
| 502 | `assistant_unavailable` | The model call failed. | Show `message`, offer retry. **The body includes `state` — save it**, so the thread isn't lost. |
| 500 | `internal_error` | Unexpected. | Generic retry. |

```js
try {
  const data = await chat.send(text);
} catch (err) {
  // err.code === 'conversation_limit' | 'rate_limited' | …
  // err.message is already safe to show for 429/502
  bubble(err.message);
}
```

## 7. Streaming (SSE) details

Send `stream: true` and the **same endpoint** responds with
`content-type: text/event-stream`. It is a `POST`, so `EventSource` cannot be used —
read `res.body` with `fetch`, as the client does.

| Event | Payload | Do |
| --- | --- | --- |
| `start` | `{ conversationId, stateStatus }` | Nothing (or start a spinner). |
| `token` | `{ token }` | Append to the current assistant bubble. |
| `tool` | `{ name }` | Show a hint: `get_pricing` → "checking pricing…", `submit_lead` → "sending your details…". |
| `done` | The full response object above | **Save `state` + `transcript`.** This is the authoritative end of the turn. |
| `error` | `{ error, message, state }` | Replace the bubble with `message`; save `state`. |

Two things that will bite you if you hand-roll the parser:

1. Frames are separated by a **blank line** (`\n\n`) and can be split across chunks —
   buffer, split on `\n\n`, keep the remainder.
2. Decode with `TextDecoderStream` (or a `TextDecoder` with `{stream:true}`) — a
   multi-byte character like `₹` can straddle two chunks.

The provided client handles both. If a stream dies before `done`, it throws
`stream_incomplete` and your last saved `state` is still valid — the turn simply
didn't happen.

---

## 8. Drop-in client

Copy [`examples/neohives-chat.js`](../examples/neohives-chat.js) into your project.

```js
import { createNeohivesChat, GREETING } from './lib/neohives-chat.js';

const chat = createNeohivesChat({
  apiUrl: import.meta.env.VITE_NEOHIVES_API_URL,
  token:  import.meta.env.VITE_NEOHIVES_CHAT_TOKEN,
});

// Paint the thread on load: saved history, or the greeting for a new visitor.
const initial = chat.history();
render(initial.length ? initial : [{ role: 'assistant', content: GREETING }]);

// Streaming send
const data = await chat.send('What does a website cost?', {
  stream: true,
  onToken: (t) => appendToBubble(t),
  onTool:  (name) => showHint(name),
});

if (data.submitted) showReference(data.submitted.reference);

chat.reset(); // "clear chat" — wipes both localStorage keys
```

It handles storage, state round-tripping, SSE parsing, typed errors, and falls back to
in-memory storage when `localStorage` throws (Safari private mode).

### React

Copy [`examples/useNeohivesChat.js`](../examples/useNeohivesChat.js) too:

```jsx
function ChatWidget() {
  const { messages, send, sending, pendingTool, submitted, reset } = useNeohivesChat();
  const [text, setText] = useState('');

  return (
    <div className="chat">
      {messages.map((m, i) => (
        <div key={i} className={m.role}>{m.content}</div>
      ))}
      {pendingTool && <div className="hint">{HINTS[pendingTool] ?? 'thinking…'}</div>}
      {submitted && <div className="note">Sent — your reference is {submitted.reference}.</div>}

      <form onSubmit={(e) => { e.preventDefault(); send(text); setText(''); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} disabled={sending} />
        <button disabled={sending || !text.trim()}>Send</button>
      </form>
      <button onClick={reset}>Clear chat</button>
    </div>
  );
}

const HINTS = {
  get_pricing: 'checking pricing…',
  get_onboarding: 'checking the onboarding steps…',
  search_faq: 'looking that up…',
  update_lead: 'noting that down…',
  submit_lead: 'sending your details to the team…',
  escalate_to_human: 'flagging this for a human…',
};
```

---

## 9. UX notes

- **The greeting is yours.** There's no endpoint for it. Use the `GREETING` constant
  in the client (kept in sync with the backend's `src/agent/prompt.js`).
- **The bot drives the conversation.** It asks for name, email, requirement, budget
  and timeline itself, one question at a time, and submits the lead once the visitor
  confirms. Don't build a form and don't nag using `missingFields` — it's there for
  display/analytics.
- **Confirm the submission.** When `submitted` first appears, show
  `submitted.reference` and "the team replies within one business day". The bot says
  this too, but a persistent line is friendlier.
- **One request in flight per conversation.** Two overlapping turns will both write
  `state` and one will clobber the other, losing a message. Disable the send button
  while `sending`.
- **Always overwrite `state` with the newest value**, including from a `502` body.
  Never send an older blob — replays are rejected by a duplicate guard, but they'll
  also desync your UI.
- **Give them a "clear chat" action** that calls `reset()`. The conversation contains
  their name and email; make it easy to delete.
- Render `reply` as **text**. The bot uses short paragraphs and occasional bullets; no
  HTML, tables, or images. If you run it through a markdown renderer, sanitise it.
- Keep the widget usable on a slow connection: streaming makes the wait feel shorter,
  but a non-streaming call is one request and simpler — both are fine.

## 10. Testing without an OpenAI key

Ask the backend team to run with `MOCK_LLM=true` (or no `OPENAI_API_KEY`). Replies
come back prefixed `[mock]` with the same response shape, tools still fire, and lead
submission still hits the webhook — so you can build the whole UI for free. Locally:

```bash
npm install
npm run token -- --secret   # paste JWT_SECRET into .env, keep the printed JWT
MOCK_LLM=true npm run dev   # http://localhost:3000 also serves a reference widget
```

The dev server's own test console (`public/index.html`) is a working reference
implementation of everything above, in one file.

## 11. Pre-launch checklist

- [ ] `API_URL` and token read from env, not hardcoded.
- [ ] Your production **and** staging origins are in the backend's `ALLOWED_ORIGINS`.
- [ ] Thread repaints correctly after a page reload (`transcript` from localStorage).
- [ ] Send button disabled while a turn is in flight.
- [ ] 401 / 429 / 502 all render something sensible instead of a blank bubble.
- [ ] `conversation_limit` offers a "start over" that clears `nh_state`.
- [ ] "Clear chat" wipes `nh_state` **and** `nh_transcript`.
- [ ] `submitted.reference` is shown to the visitor.
- [ ] No OpenAI key anywhere in the frontend.
