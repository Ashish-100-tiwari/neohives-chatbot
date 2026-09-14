# Neo Hives chatbot — frontend integration guide

Everything you need to put the "Hive" assistant on the site. **One endpoint, one header,
one localStorage key.**

- **Live API:** `https://neohives-chatbot.onrender.com`
- **Endpoint:** `POST https://neohives-chatbot.onrender.com/api/chat`
- **Auth:** `Authorization: Bearer <token>` — a permanent JWT the backend team gives you.
- **Memory:** the server stores nothing. Each response returns a `state` string; you keep
  it in `localStorage` and send it back with the next message.

Copy-paste client: [`examples/neohives-chat.js`](../examples/neohives-chat.js) ·
React hook: [`examples/useNeohivesChat.js`](../examples/useNeohivesChat.js) ·
Runnable curl walkthrough: [`examples/curl.sh`](../examples/curl.sh)

A working reference widget is deployed at
<https://neohives-chatbot.onrender.com/> — open it, paste the token when prompted, and
you have a live example of everything in this document.

---

## 0. Read this first — two things that will block you

### CORS is currently allowlisted to two origins only

Verified against the live deployment:

| Origin | Preflight result |
| --- | --- |
| `https://neohives.com` | ✅ allowed |
| `http://localhost:3000` | ✅ allowed |
| `https://www.neohives.com` | ❌ **blocked** |
| `http://localhost:5173` (Vite default) | ❌ **blocked** |

A blocked origin gets a `204` with **no** `Access-Control-Allow-Origin` header, so the
browser kills the request and you see a bare "CORS error" in the console with no useful
body. It is not a bug in your code.

**Before you start,** ask the backend team to add your origins to `ALLOWED_ORIGINS` in
the Render dashboard (Environment → `ALLOWED_ORIGINS`, comma-separated, then redeploy).
You almost certainly need:

```
http://localhost:3000,http://localhost:5173,https://neohives.com,https://www.neohives.com
```

Include `www` **and** the bare domain — they are different origins to a browser. Add your
staging/preview domain too (Vercel/Netlify preview URLs change per deploy, so ask for the
stable alias).

Server-side calls (Next.js route handlers, SSR) are not subject to CORS and work today.

### The token in use is a development token

The JWT currently accepted by the deployment was minted in a dev session and printed to a
terminal log. Before public launch, ask the backend team to rotate it:

```bash
npm run token -- --secret   # new JWT_SECRET + new JWT
```

…update `JWT_SECRET` on Render, and hand you the new JWT. Build against the current one;
just don't ship it to production without asking whether it was rotated.

---

## 1. What you need from the backend team

| Thing | Value | Notes |
| --- | --- | --- |
| API base URL | `https://neohives-chatbot.onrender.com` | no trailing slash |
| Chat token | `eyJhbGciOiJIUzI1NiIs…` (~275 chars) | never expires |
| Your origins allowlisted | see §0 | **CORS fails without this** |

```bash
# .env (Vite)
VITE_NEOHIVES_API_URL=https://neohives-chatbot.onrender.com
VITE_NEOHIVES_CHAT_TOKEN=eyJhbGciOiJIUzI1NiIs…

# .env (Next.js)
NEXT_PUBLIC_NEOHIVES_API_URL=https://neohives-chatbot.onrender.com
NEXT_PUBLIC_NEOHIVES_CHAT_TOKEN=eyJhbGciOiJIUzI1NiIs…
```

This token ends up in your JS bundle and is readable in DevTools — that is expected and by
design. It identifies *the website*, not the visitor, so **never treat it as a secret and
never gate anything else with it.** The OpenAI key is not here and must never be: it lives
only on the backend.

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
  verifies a signature and silently starts a new conversation if it doesn't match. Render
  your UI from `transcript` instead.

---

## 3. curl quickstart (against the live API)

```bash
export API=https://neohives-chatbot.onrender.com
export TOKEN='eyJhbGciOiJIUzI1NiIs…'
```

### Health check

```bash
curl -s $API/health
# {"status":"ok"}
```

### First message

```bash
curl -sS -X POST "$API/api/chat" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{
    "message": "Can you automate our invoice processing?",
    "pageUrl": "https://neohives.com/ai-services",
    "locale":  "en-US",
    "utm":     { "utm_source": "google", "utm_campaign": "ai-agents" }
  }'
```

Real response from the live deployment:

```json
{
  "reply": "Yes, we can potentially build an AI workflow to automate your invoice processing. This could involve extracting invoice data, validating it against your ERP system, and sending any exceptions to a human reviewer.\n\nTo better understand your needs, could you share more about your current process and any specific requirements you have?",
  "state": "nhc1.fZJBb9swDIX_CsGznMZJlra-DMWww27D1h7Wr…",
  "conversationId": "fd0265c8-dfe6-41e2-af18-d19c61efccd8",
  "turns": 1,
  "lead": {},
  "missingFields": ["email", "service_interest"],
  "submitted": null,
  "escalated": false,
  "toolsUsed": [],
  "stateStatus": "new",
  "transcript": [
    { "role": "user", "content": "Can you automate our invoice processing?", "at": "2026-09-13T11:43:02.737Z" },
    { "role": "assistant", "content": "Yes, we can potentially build an AI workflow…", "at": "2026-09-13T11:43:03.744Z" }
  ]
}
```

### Follow-up message (with memory)

The state blob is long, so build the body in a file rather than fighting your shell:

```bash
echo '<the state value from the previous response>' > /tmp/state.txt

node -e 'require("fs").writeFileSync("/tmp/body.json", JSON.stringify({
  message: "I am Priya from Swift Freight, priya@swiftfreight.com, about 3000 invoices a month",
  state: require("fs").readFileSync("/tmp/state.txt","utf8").trim()
}))'

curl -sS -X POST "$API/api/chat" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d @/tmp/body.json
```

```json
{
  "turns": 2,
  "stateStatus": "resumed",
  "toolsUsed": ["update_lead"],
  "lead": {
    "name": "Priya",
    "email": "priya@swiftfreight.com",
    "company": "Swift Freight",
    "service_interest": "AI agents & automation",
    "requirement": "Automate invoice processing",
    "expected_volume": "3000 invoices/month"
  },
  "missingFields": [],
  "submitted": { "reference": "NH-260913-7C41AE", "at": "2026-09-13T11:45:10.220Z", "delivery": "delivered" }
}
```

`stateStatus: "resumed"` and the growing `turns` confirm the memory round-trip worked.
`submitted` is already populated: this turn supplied both an email and a service interest,
which is all the backend needs to send the enquiry.

### Streaming

Verified working through Render's proxy:

```bash
curl -sS -N -X POST "$API/api/chat" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"message":"Do you use OpenAI?","stream":true}'
```

```
event: start
data: {"conversationId":"06984511-6900-4730-a2fa-85296c659386","stateStatus":"new"}

event: tool
data: {"name":"get_tech_stack"}

event: token
data: {"token":"Yes"}

event: token
data: {"token":","}

…

event: done
data: {"reply":"Yes, Neo Hives works with OpenAI models…","state":"nhc1.…","turns":1,…}
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
| `locale` | string | no | e.g. `navigator.language`. The bot mirrors the visitor's language. |
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
| `lead` | object | What's been captured — see below. All keys optional. |
| `missingFields` | array | Which of `email`/`service_interest` are still needed before the enquiry can be sent. Informational — the bot asks for them itself. |
| `submitted` | object\|null | `{ reference, at, delivery }` once the enquiry has been sent. Show the `reference`. |
| `escalated` | boolean | A human has been flagged for this conversation. |
| `toolsUsed` | array | Which tools ran this turn. Debugging / analytics / progress hints. |
| `stateStatus` | string | `new` \| `resumed` \| `invalid` \| `too_large` — see below. |

### `lead` fields

```
name  email  phone  company  country  industry  service_interest  requirement
current_technology  required_integrations  expected_volume  number_of_users
budget_range  timeline  preferred_contact_time  notes
```

All optional and all strings. The bot fills them in as the conversation goes; you only
need to display them if you want a "here's what we've got so far" panel.

### `stateStatus`

| Value | Meaning | What to do |
| --- | --- | --- |
| `new` | No state was sent; fresh conversation. | Nothing. |
| `resumed` | State verified, memory intact. | Nothing. |
| `invalid` | State was corrupt, truncated or tampered with — the server started over. | Optional: clear your saved transcript so the UI matches the bot's memory. |
| `too_large` | State exceeded the size cap; started over. | Same. Shouldn't happen in practice. |

The server never errors on a bad `state` — it just begins a new conversation. If you see
`invalid` unexpectedly, you're probably storing a stale or mangled blob.

## 6. Errors

Every error body has `error` (a stable machine code) and usually `message` and/or `reply`.
**When `reply` is present it is visitor-safe copy — show it in the bubble.**

| Status | `error` | Meaning | Handling |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Bad/missing field; see `details[]`. | Bug in your code. |
| 400 | `invalid_json` | Malformed body. | Bug in your code. |
| 401 | `missing_token` | No `Authorization` header. | Check your env var is actually inlined at build time. |
| 401 | `invalid_token` | Wrong/garbled token, or the secret was rotated. | Get a fresh token from the backend team. |
| 401 | `revoked_token` | The token was revoked. | Same. |
| 413 | `payload_too_large` | Body over 256 KB. | Your `state` is bloated — clear it. |
| 429 | `rate_limited` | Too many requests from this IP. **20 per 60s** on the live deployment. | Show `reply`, disable the input briefly. Honour `Retry-After`. |
| 429 | `conversation_limit` | This conversation hit the 40-turn cap. | Show `reply` (it points them at email) and offer "start over" that clears `nh_state`. |
| 502 | `assistant_unavailable` | The model call failed. | Show `message`, offer retry. **The body includes `state` — save it**, so the thread isn't lost. |
| 500 | `internal_error` | Unexpected. | Generic retry. |

The live API returns standard rate-limit headers you can read for a nicer UX:

```
ratelimit: limit=20, remaining=17, reset=25
ratelimit-policy: 20;w=60
```

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

Send `stream: true` and the **same endpoint** responds with `content-type:
text/event-stream`. It is a `POST`, so `EventSource` cannot be used — read `res.body` with
`fetch`, as the client does.

| Event | Payload | Do |
| --- | --- | --- |
| `start` | `{ conversationId, stateStatus }` | Nothing (or start a spinner). |
| `token` | `{ token }` | Append to the current assistant bubble. |
| `tool` | `{ name }` | Show a hint — see the `HINTS` map in §8. |
| `done` | The full response object above | **Save `state` + `transcript`.** Authoritative end of turn. |
| `error` | `{ error, message, state }` | Replace the bubble with `message`; save `state`. |

Two things that will bite you if you hand-roll the parser:

1. Frames are separated by a **blank line** (`\n\n`) and can be split across chunks —
   buffer, split on `\n\n`, keep the remainder.
2. Decode with `TextDecoderStream` (or a `TextDecoder` with `{stream:true}`) — a multi-byte
   character like `₹` or `—` can straddle two chunks.

The provided client handles both. If a stream dies before `done`, it throws
`stream_incomplete` and your last saved `state` is still valid — the turn simply didn't
happen.

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
const data = await chat.send('Can you automate our invoice processing?', {
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
  get_pricing:       'checking pricing…',
  get_services:      'checking what we build…',
  get_case_studies:  'pulling up client results…',
  get_security:      'checking our security posture…',
  get_tech_stack:    'checking our stack…',
  get_onboarding:    'checking the process…',
  search_faq:        'looking that up…',
  update_lead:       'noting that down…',
  submit_lead:       'sending your details to the team…',
  escalate_to_human: 'flagging this for a human…',
};
```

---

## 9. UX notes

- **The greeting is yours.** There's no endpoint for it. Use the `GREETING` constant in the
  client (kept in sync with the backend's `src/agent/prompt.js`).
- **The bot drives the conversation.** It asks for name, email, requirement, volumes,
  integrations, budget and timeline itself, one question at a time. Don't build a form, and
  don't nag using `missingFields` — it's there for display/analytics.
- **Submission happens mid-conversation, not at the end.** The enquiry is sent as soon as
  the bot has an `email` and a `service_interest`, so `submitted` usually appears while the
  visitor is still chatting. Everything they say afterwards is forwarded against the same
  reference automatically — so keep the chat open and don't treat `submitted` as an
  end-of-flow signal.
- **Confirm the submission.** When `submitted` first appears, show `submitted.reference`
  and "a senior engineer replies within 24 hours". The bot says this too, but a persistent
  line is friendlier.
- **One request in flight per conversation.** Two overlapping turns will both write `state`
  and one will clobber the other, losing a message. Disable send while `sending`.
- **Always overwrite `state` with the newest value**, including from a `502` body. Never
  send an older blob — replays are caught by a duplicate guard, but they'll desync your UI.
- **Give them a "clear chat" action** that calls `reset()`. The conversation contains their
  name and email; make it easy to delete.
- Render `reply` as **text**. The bot uses short paragraphs and occasional bullets, and
  sometimes `**bold**`; no HTML, tables, or images. If you run it through a markdown
  renderer, sanitise it.
- **First request after idle may be slow.** If the service is on Render's free tier it
  spins down when idle and the next request pays a cold start of up to ~50s. Don't let your
  fetch time out at 10s, and show a "connecting…" state rather than an error. Confirm the
  plan with the backend team; on a paid instance this doesn't apply.
- Streaming makes the wait feel shorter, but a non-streaming call is one request and
  simpler — both are fine.

## 10. Testing without burning OpenAI credits

Ask the backend team to run a **local** instance with `MOCK_LLM=true` (or no
`OPENAI_API_KEY`). Replies come back prefixed `[mock]` with an identical response shape,
tools still fire, and lead submission still hits the webhook — so you can build the whole
UI for free. Locally:

```bash
npm install
npm run token -- --secret   # paste JWT_SECRET into .env, keep the printed JWT
MOCK_LLM=true npm run dev   # http://localhost:3000, also serves the reference widget
```

Note the live deployment runs the **real** model, so every message there costs money and
counts against the 20/min rate limit. Use mock mode for UI iteration and the live API for
final integration checks.

## 11. Pre-launch checklist

- [ ] `API_URL` and token read from env, not hardcoded.
- [ ] Your production, `www`, staging **and** localhost origins are all in the backend's
      `ALLOWED_ORIGINS` (see §0 — this is the most common failure).
- [ ] Token has been rotated from the dev one (§0).
- [ ] Thread repaints correctly after a page reload (`transcript` from localStorage).
- [ ] Send button disabled while a turn is in flight.
- [ ] 401 / 429 / 502 all render something sensible instead of a blank bubble.
- [ ] Cold start handled: no short fetch timeout, "connecting…" state shown.
- [ ] `conversation_limit` offers a "start over" that clears `nh_state`.
- [ ] "Clear chat" wipes `nh_state` **and** `nh_transcript`.
- [ ] `submitted.reference` is shown to the visitor.
- [ ] No OpenAI key anywhere in the frontend.
