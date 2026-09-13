# Neohives chatbot backend

Node.js backend for the **Neohives** website assistant ("Hive"). It sits between a
prospective client and the sales team:

1. answers questions about **services, pricing and onboarding** — strictly from a
   knowledge file, so it can't invent numbers;
2. **captures the visitor's details** and what they need, conversationally;
3. **submits the lead to a webhook** (n8n / Zapier / Make / your CRM) and hands the
   visitor a reference id.

Express 5 + the OpenAI (ChatGPT) API with function calling. **One endpoint**, guarded
by **one non-expiring JWT**, and **zero server-side session state** — the
conversation lives in the browser's `localStorage`.

---

## Quick start

```bash
npm install
cp .env.example .env

npm run token -- --secret   # prints JWT_SECRET (backend) + the JWT (frontend)
# paste JWT_SECRET into this project's .env, then set OPENAI_API_KEY + LEAD_WEBHOOK_URL

npm run dev                 # http://localhost:3000
```

Open <http://localhost:3000> for a test console — paste the JWT once when prompted.
It stores the token and the conversation in `localStorage`, exactly like the real
widget should, and shows the captured lead after every turn.

```bash
npm start          # production
npm test           # 27 tests, no API key needed
```

**Building the widget?** Hand your frontend developer
[`docs/FRONTEND.md`](docs/FRONTEND.md) — curl walkthrough, the full request/response
contract, error handling, and a copy-paste client (`examples/neohives-chat.js`) plus a
React hook (`examples/useNeohivesChat.js`).

Without `OPENAI_API_KEY` the server boots in **mock mode**: a rule-based stand-in
that exercises the same tool-calling path, so you can develop the frontend and test
webhooks for free. That is also how the test suite runs.

---

## Authentication — one permanent token

```bash
npm run token                     # mint another token with the existing secret
npm run token -- --label staging  # tag it so you know which build it went to
```

The minted JWT is **HS256 with no `exp` claim, so it never expires**. Put it in the
frontend's env:

```bash
# Vite
VITE_NEOHIVES_CHAT_TOKEN=eyJhbGciOiJIUzI1NiIs...
# Next.js
NEXT_PUBLIC_NEOHIVES_CHAT_TOKEN=eyJhbGciOiJIUzI1NiIs...
```

and send it on every request:

```
Authorization: Bearer <token>
```

`JWT_SECRET` stays on the server only. Verification pins `algorithms: ['HS256']` and
checks `iss` + `aud`, so `alg: none` and algorithm-confusion downgrades are rejected
(there are tests for both).

> ### Read this before you ship it
> **A token in a frontend `.env` is public.** Vite and Next inline
> `VITE_*` / `NEXT_PUBLIC_*` values into the JS bundle, so anyone can copy it out of
> DevTools and call your API directly — on your OpenAI bill. Treat it as an API key
> that identifies *the app*, not the visitor. What actually limits the damage:
> - per-IP rate limit (`RATE_LIMIT_*`, default 20 req/min);
> - per-conversation turn cap (`MAX_TURNS_PER_CONVERSATION`, default 40);
> - `ALLOWED_ORIGINS` (blocks other websites' browser calls, not scripts);
> - the duplicate-lead guard, so a replayed conversation can't spam your webhook;
> - revocation: add the token's `jti` to `REVOKED_TOKEN_IDS` (printed when you mint),
>   or rotate `JWT_SECRET` to invalidate every token at once.
>
> If you later want per-visitor auth, keep this endpoint and have your own site
> issue short-lived tokens from a server route — nothing here needs to change except
> the `exp` check.

---

## The single endpoint

```
POST /api/chat
Authorization: Bearer <token>
Content-Type: application/json

{
  "message": "What does a client portal cost?",
  "state":   "nhc1.…",          // omit on the first turn
  "stream":  false,              // true (or Accept: text/event-stream) for SSE
  "pageUrl": "https://neohives.com/pricing",
  "locale":  "en-IN",
  "utm":     { "utm_source": "google" }
}
```

Response:

```json
{
  "reply": "Our Growth plan starts from ₹1,25,000 …",
  "state": "nhc1.eJyNVE1v…",
  "conversationId": "7d2c…",
  "turns": 3,
  "lead": { "name": "Sam", "email": "sam@acme.io", "requirement": "Client portal" },
  "missingFields": [],
  "submitted": { "reference": "NH-260912-A3F91C", "at": "…", "delivery": "delivered" },
  "escalated": false,
  "toolsUsed": ["get_pricing", "update_lead"],
  "stateStatus": "resumed",
  "transcript": [{ "role": "user", "content": "…", "at": "…" }]
}
```

`GET /health` → `{"status":"ok"}` is the only other route: an unauthenticated
liveness probe for your host (Render/Fly/K8s). It reveals nothing; delete it if your
platform doesn't need it.

**Errors** — `401` (`missing_token` / `invalid_token` / `revoked_token`), `400`
(`invalid_request`, `invalid_json`), `429` (`rate_limited`, `conversation_limit`),
`502` (`assistant_unavailable`), `413`, `500`. The `429`/`502` bodies include a
`reply` you can show verbatim, and `502` returns your `state` unchanged so the
visitor doesn't lose the thread.

### SSE events (`stream: true`)

| Event | Payload |
| --- | --- |
| `start` | `{ conversationId, stateStatus }` |
| `token` | `{ token }` — append to the bubble |
| `tool` | `{ name }` — e.g. show "checking pricing…" |
| `done` | the full JSON response above, **including the new `state`** |
| `error` | `{ error, message, state }` |

---

## Memory: signed state in localStorage

The server keeps **nothing** between requests. Each response carries a `state`
string — the whole conversation (history, captured lead, submissions, first-touch
attribution) deflated, base64url'd and **HMAC-SHA256 signed**:

```
nhc1.<deflate+base64url payload>.<hmac>
```

Store it verbatim and send it back on the next turn:

```js
const res = await fetch(`${API}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    message,
    state: localStorage.getItem('nh_state') ?? undefined,
    pageUrl: location.href,
    locale: navigator.language,
  }),
});
const data = await res.json();
localStorage.setItem('nh_state', data.state);           // memory
localStorage.setItem('nh_transcript', JSON.stringify(data.transcript)); // for repainting the UI
```

The signature is the point: **it is treated as untrusted client input.** Without it a
visitor could forge assistant turns, fake tool results, or rewrite their own captured
lead before it reaches your webhook. A tampered, truncated or garbage blob is not
something the visitor can fix, so the server logs it and starts a fresh conversation
rather than failing the request — check `stateStatus` (`new` / `resumed` / `invalid` /
`too_large`) if you want to tell them.

`state` is opaque; render your UI from `transcript` instead of trying to decode it.
It runs ~2.5 KB after one turn and is capped by `MAX_HISTORY_MESSAGES` (30) and
`MAX_STATE_BYTES` (128 KB), well inside localStorage's ~5 MB.

**What signing does not stop is replay** — a client can resend an older blob from
before a lead was submitted. The turn cap plus an in-memory duplicate guard
(`src/services/dedupe.js`: same email + requirement inside 6 hours returns the
original reference instead of firing the webhook) cover that.

Show the opening line from your own frontend — there's no endpoint for it. The exact
text lives in `GREETING` in `src/agent/prompt.js`.

---

## How a turn works

```
POST /api/chat ─► verify JWT ─► verify + decode state ─► build system prompt
                                                              │
                                                              ▼
                                                   ChatGPT completion
                                                              │
                                          tool_calls? ──► run tools ──┐
                                                    ▲                 │
                                                    └── feed back ────┘
                                                              │
                                                              ▼
                                             reply + re-signed state
```

The loop is in `src/agent/runner.js`, capped at `config.maxToolIterations` (6) so a
confused model can't spin.

### Tools the model can call (`src/agent/tools.js`)

| Tool | What it does |
| --- | --- |
| `get_pricing` | Plans, service starting prices, retainers, discounts, payment terms |
| `get_onboarding` | The 6 onboarding steps + what the client must provide |
| `search_faq` | NDA, code ownership, international clients, scope changes |
| `update_lead` | Merges newly learned visitor details into the conversation |
| `submit_lead` | Validates, then POSTs the lead to the webhook; returns a reference |
| `escalate_to_human` | Flags custom pricing / legal / complaints for a human |

`submit_lead` won't fire unless `name`, `email` and `requirement` are present **and**
the model passes `confirmed_by_visitor: true`, and it's idempotent per conversation.

---

## The webhook payload

Every submission POSTs this to `LEAD_WEBHOOK_URL`. **Key names are stable** — map
them once in n8n/Zapier and they won't move:

```json
{
  "event": "lead.submitted",
  "reference": "NH-260912-A3F91C",
  "submitted_at": "2026-09-12T09:14:22.101Z",
  "source": "website-chatbot",
  "company": "Neohives",
  "session": { "id": "…", "started_at": "…", "message_count": 12, "turns": 6 },
  "lead": {
    "name": "Sam Rao",
    "email": "sam@acme.io",
    "phone": "+91 90000 00000",
    "company": "Acme",
    "service_interest": "web-apps",
    "requirement": "Client portal with billing",
    "budget_range": "2-3 lakh",
    "timeline": "next month",
    "preferred_contact_time": "weekday mornings",
    "notes": "…"
  },
  "context": { "page_url": "…", "referrer": "…", "locale": "en-IN", "utm": null, "user_agent": "…", "ip": "…" },
  "transcript": [{ "role": "user", "content": "…", "at": "…" }],
  "summary": "Wants a client portal, budget 2-3 lakh, start next month."
}
```

`event` is `lead.submitted` or `lead.escalated` (the latter adds
`escalation: { reason, urgency }`).

### Verifying the signature

Set `LEAD_WEBHOOK_SECRET` and each request carries
`X-Neohives-Signature: sha256=<hex>` — an HMAC-SHA256 of the **raw** body, plus
`X-Neohives-Timestamp`. On the receiving side:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
// compare with crypto.timingSafeEqual
```

### Delivery guarantees

- Every payload is appended to `data/leads.jsonl` **before** the HTTP call, so a
  lead survives a webhook outage.
- Retries with exponential backoff (`WEBHOOK_MAX_RETRIES`, default 3) on network
  errors and 408/425/429/5xx. Non-retryable 4xx fails fast.
- Permanent failures land in `data/failed-webhooks.jsonl`. Replay them with:
  ```bash
  npm run replay -- --dry-run   # inspect
  npm run replay                # resend
  ```
- Because the lead is safely on disk, the visitor still gets a reference id; the
  `delivery` field (`delivered` / `queued` / `skipped` / `duplicate`) tells ops what
  happened.

---

## Editing pricing and onboarding content

`src/data/knowledge.json` is the bot's **only** source of commercial truth — the
system prompt forbids inventing anything not in there. The placeholder plans, prices
and onboarding steps in it are illustrative: **replace them with Neohives' real
numbers before going live.**

- In development the file hot-reloads on save.
- In production, restart (or redeploy) to pick up edits.
- `plans[].price` set to `null` (the *Scale* plan) means "quote only" and the prompt
  blocks the model from guessing a figure.

Tone, the questions asked, and the escalation rules live in `src/agent/prompt.js`.

---

## Configuration

All via `.env` (see `.env.example`):

| Group | Vars |
| --- | --- |
| Auth | `JWT_SECRET` (required), `JWT_ISSUER`, `JWT_AUDIENCE`, `REVOKED_TOKEN_IDS` |
| Memory | `STATE_SECRET` (defaults to `JWT_SECRET`), `MAX_HISTORY_MESSAGES`, `MAX_TURNS_PER_CONVERSATION`, `MAX_STATE_BYTES` |
| Model | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_OUTPUT_TOKENS`, `MOCK_LLM` |
| Webhook | `LEAD_WEBHOOK_URL`, `LEAD_WEBHOOK_SECRET`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_RETRIES` |
| Server | `PORT`, `NODE_ENV`, `ALLOWED_ORIGINS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `LOG_LEVEL` |

The server refuses to boot without a `JWT_SECRET` of at least 32 characters
(`assertConfig()` in `src/config.js`).

## Layout

```
src/
  index.js              entry point, config check, graceful shutdown
  app.js                express wiring: CORS, rate limit, auth, error handler
  config.js             env parsing + boot-time validation
  auth/token.js         mint / verify the non-expiring JWT, requireToken middleware
  agent/
    prompt.js           system prompt (persona, rules, capture flow) + GREETING
    tools.js            tool schemas + implementations
    runner.js           model ⇄ tool loop, streaming and non-streaming
    mockModel.js        offline stand-in for the ChatGPT API
  services/
    conversation.js     signed state blob: encode/decode, history trimming
    dedupe.js           duplicate/replay guard for submissions
    leadSchema.js       zod validation + required-field rules
    openaiClient.js     lazily built SDK client
    webhook.js          payload builder, HMAC signing, retries, dead letter
  data/knowledge.json   ← pricing / onboarding content (edit this)
  routes/api.js         the one endpoint
docs/FRONTEND.md        integration guide for the frontend developer
examples/
  neohives-chat.js      drop-in browser client (no dependencies)
  useNeohivesChat.js    React hook built on it
  curl.sh               runnable curl walkthrough of a whole conversation
public/index.html       test console (dev only — not served when NODE_ENV=production)
scripts/mint-token.js   npm run token
scripts/replay-failed.js
test/api.test.js        endpoint, auth and webhook tests
test/client.test.js     drives examples/neohives-chat.js against a real server
```

## Before production

- **Set `ALLOWED_ORIGINS`** to `https://neohives.com` (plus staging). It allows all
  origins when unset, which is only right for local dev.
- **Rotate the secrets** if the ones you generated locally ever touched a chat log or
  a screenshot, then re-mint the frontend token.
- **Abuse control.** The public token means rate limiting is your real defence. Put
  the endpoint behind Cloudflare (or Turnstile on the widget) if traffic warrants it,
  and set `MAX_TURNS_PER_CONVERSATION` to whatever you're willing to pay for.
- **Cost.** Every turn resends the trimmed history; lower `MAX_HISTORY_MESSAGES` or
  change `OPENAI_MODEL` to trade quality for cost.
- **Privacy.** `data/leads.jsonl` and the transcript in each webhook payload contain
  personal data, and the conversation sits in the visitor's browser. Set a retention
  policy, keep the file off public storage, and give the widget a "clear chat" action
  that deletes the localStorage keys.
- **`data/` needs a real disk** if you rely on the dead-letter replay — on ephemeral
  container filesystems, point the webhook at something durable instead.
- **The OpenAI key stays server-side.** The browser only ever sees the chat JWT.
