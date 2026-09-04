# must_chatbot — backend

Express backend for a website whose only purpose is a chatbot. Conversations are
addressed by UUID, stored in Postgres for later review, and streamed to the browser
over **resumable** Server-Sent Events.

## How a turn works

```
POST /api/conversations/:id/messages
        │  writes user + placeholder assistant rows, returns 202 immediately
        └─► background runner ──► agent service
                                  every token ──► XADD ──► Redis stream chat:stream:{messageId}
                                  at the end   ──► UPDATE messages SET content, status='complete'

GET  /api/conversations/:id/stream?messageId=…
        XRANGE from Last-Event-ID   (replay what the client missed)
        XREAD BLOCK                 (follow live)
        emit done / error, close
```

Sending and streaming are **separate requests** on purpose. The POST never holds a
response open, so a reload, a second tab, a phone leaving a tunnel, or a deploy can
all rejoin the same generation — none of which is possible if the tokens only ever
exist inside one POST response. The Redis entry id is handed to the browser as the
SSE `id:` field and comes back as `Last-Event-ID`, which is what makes resume exact:
no gaps, no repeated text.

Because the buffer lives in Redis rather than in process memory, the instance that
serves the stream does not have to be the instance that is generating. No sticky
sessions.

## Requirements

- Node 20+
- PostgreSQL (any host — managed, local, or remote)
- Redis (any host)

## Setup

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL, REDIS_URL, COOKIE_SECRET
npm run prisma:migrate        # creates the tables
npm run dev                   # http://localhost:4000
```

`COOKIE_SECRET` must be a real random string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## The agent service — MUST Academic Assistant

Contract confirmed against `MUST_Academic_Assistant_Website_API_Handoff_V1.md`
("Stable Contract — Production Text Backend V1"; the older
`MUST_Agent_Frontend_API_Integration_Guide.md` describes the same shape minus the
onboarding profile). The agent owns conversation memory itself, keyed by a
`session_id` it does not generate — **our conversation UUID is that session_id**,
sent straight through. One conversation here = one session there, same lifecycle
(new chat → new id, refresh → same id), so no separate mapping table exists.

```
POST {AGENT_BASE_URL}/chat                              session_id >= 8 chars, question >= 2 chars
  -> { session_id, question }
  <- { session_id, question, standalone_question, answer, sources,
       profile: { gpa, completed_hours, major, completed_courses },
       onboarding_complete, history_size }

DELETE {AGENT_BASE_URL}/session/{session_id}             best-effort, on conversation delete
  <- { status: "ended", session_id }

GET {AGENT_BASE_URL}/health                               polled by /readyz, informational only
```

Production base URL: `https://must-academic-assistant-backend.onrender.com`
(pre-filled in `.env.example`; `AGENT_MODE` still defaults to `mock` — flip it
deliberately, since `http` mode makes real calls to that service).

We send **only the new question**, never a transcript — the agent does follow-up
detection, standalone-question rewriting, and a GPA/hours/major **onboarding
flow**, all server-side from its own memory of that session. The doc: "Do not
duplicate backend logic" — we don't compute or validate any of that here, only
relay and persist it.

The backend talks to it through one small interface
([src/agent/types.ts](src/agent/types.ts)), with three implementations selected by
`AGENT_MODE`:

| `AGENT_MODE` | Implementation | When |
| --- | --- | --- |
| `mock` | [mockAgent.ts](src/agent/mockAgent.ts) | Local dev and tests. No network. |
| `http` | [httpAgent.ts](src/agent/httpAgent.ts) | **Today.** `/chat` is one JSON reply; re-emitted as small deltas so the UI still paints progressively. |
| `http-stream` | [streamingHttpAgent.ts](src/agent/streamingHttpAgent.ts) | **Speculative** — the doc describes no streaming variant. Don't use until the agent team confirms a shape; re-verify before flipping the env var. |

Per the doc's error table: the agent returns **422** for a malformed request
(shouldn't happen — our own validation mirrors its minimums) and **500** for a
backend/provider failure; both surface here as `agent_unavailable` with the
status/body logged for debugging.

`sources`, `standalone_question`, `profile`, and `onboarding_complete` from the
`done` reply are persisted:

- On the assistant's `Message` row (`sources`, `standaloneQuestion`, `profile`,
  `onboardingComplete`) — a per-turn audit trail, useful when reviewing a
  conversation later.
- Mirrored onto the `Conversation` row (`profile`, `onboardingComplete`) — the
  latest snapshot, so a list/detail view doesn't need to join into messages.

Per the doc, these are **optional UI/review state**, not something to build
academic logic around — display `answer`, and treat `profile`/`onboardingComplete`
as presentation-only if you use them at all.

Set `AGENT_MODE=http` and `AGENT_BASE_URL` (base URL only, no `/chat` suffix — see
[.env.example](.env.example)) to point at the real service.

## API

Base path `/api`. Auth is an anonymous, signed, httpOnly `sid` cookie minted on
first contact — the browser must send `credentials: 'include'`. A conversation
belonging to another visitor returns **404**, never 403, so a UUID can't be probed.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/conversations` | → `201 { id, title, createdAt, lastMessageAt }` |
| `GET` | `/conversations?cursor=` | This visitor's threads, newest activity first |
| `GET` | `/conversations/:id?cursor=` | Metadata + `profile`/`onboardingComplete` + messages, oldest → newest |
| `PATCH` | `/conversations/:id` | `{ title }` |
| `DELETE` | `/conversations/:id` | Soft delete — the transcript is kept; best-effort tells the agent to drop its session |
| `POST` | `/conversations/:id/messages` | `{ content }` → `202 { userMessageId, assistantMessageId, streamUrl }` |
| `GET` | `/conversations/:id/stream?messageId=` | SSE. Honours `Last-Event-ID` |
| `POST` | `/conversations/:id/messages/:messageId/cancel` | → `202` |
| `GET` | `/healthz` · `/readyz` | Liveness · readiness (pings PG + Redis; agent `/health` is informational, doesn't fail readiness) |

Errors are always `{ "error": { "code", "message", "details?" } }`. Switch on
`code`, never on the message: `bad_request`, `not_found`, `conflict`,
`conversation_full`, `rate_limited`, `agent_unavailable`, `agent_timeout`,
`shutdown`, `internal`.

### SSE events

| Event | Data | Meaning |
| --- | --- | --- |
| `open` | `{ messageId, resumedFrom }` | Stream attached |
| `delta` | `{ text }` | **Append** to the bubble |
| `reset` | `{ messageId, content }` | **Replace** the bubble — the buffer expired, this is the stored answer |
| `usage` | `{ promptTokens, outputTokens }` | Token accounting |
| `done` | `{ messageId, finishReason, profile?, onboardingComplete? }` | Finished (`stop` or `cancelled`) |
| `error` | `{ code, message }` | Failed; the row records the same code |

`delta`, `usage`, `done` and `error` carry an `id:`. Keep the last one and send it
back as `Last-Event-ID` to resume. `reset` deliberately has none.

`sources` and `standaloneQuestion` are not streamed — they're written straight to
Postgres and read back via `GET /conversations/:id` (see [The agent
service](#the-agent-service--must-academic-assistant) above).

A `: ping` comment every 15s keeps proxies from dropping an idle connection.

### Frontend sketch

```js
const { assistantMessageId, streamUrl } = await (
  await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',          // the sid cookie is the session
    body: JSON.stringify({ content }),
  })
).json();

// EventSource resends Last-Event-ID on reconnect for free.
const es = new EventSource(streamUrl, { withCredentials: true });
es.addEventListener('delta', (e) => (bubble.textContent += JSON.parse(e.data).text));
es.addEventListener('reset', (e) => (bubble.textContent = JSON.parse(e.data).content));
es.addEventListener('done', () => es.close());
es.addEventListener('error', (e) => { showError(JSON.parse(e.data)); es.close(); });
```

To stop a reply: `POST /api/conversations/:id/messages/${assistantMessageId}/cancel`.
Partial text is kept and the row lands on `cancelled`.

## Guarantees worth knowing

- **An assistant row never stays `pending`.** Success, agent error, timeout,
  cancellation and a server restart all land on a terminal status.
- **One reply in flight per conversation.** A second `POST` gets `409`.
- **A retried POST cannot double-generate.** A Redis `NX` lock on the assistant
  message id gates the runner.
- **Restart safety.** On boot, assistant rows older than the agent timeout that are
  still in flight are marked `error`; the age filter keeps this safe to run while
  sibling instances are generating.
- **Graceful shutdown.** SIGTERM sends `error {code:'shutdown'}` to open streams so
  browsers reconnect (possibly to another instance) instead of hanging.

## Deployment notes

Two settings account for most "streaming works locally, dies in production" reports:

- Do not put a **buffering or compressing** proxy in front of `text/event-stream`.
  The app already sends `Cache-Control: no-transform` and `X-Accel-Buffering: no`;
  on nginx also set `proxy_buffering off;` for the stream route.
- Proxy and load-balancer **idle timeouts** must exceed the longest expected answer.
  Node's own `keepAliveTimeout` is already raised to 120s in [server.ts](src/server.ts).

Set `CORS_ORIGINS` to your site's exact origin, and keep `NODE_ENV=production` so
the cookie is `secure`.

## Layout

```
src/
  app.ts / server.ts          express wiring; listen + graceful shutdown
  config/env.ts               zod-validated env, fails fast at boot
  agent/                      the ONLY place that knows the agent service
  services/chat.service.ts    persist -> run -> buffer -> finalize
  services/streamBuffer.ts    the ONLY place that knows Redis Streams
  routes/stream.routes.ts     SSE + resume
  middleware/                 visitor session, rate limits, errors
prisma/schema.prisma          Visitor / Conversation / Message
tests/                        integration tests against a real PG + Redis
```

## Tests

Integration tests, so they need a reachable Postgres and Redis (point
`DATABASE_URL` at a scratch database — `resetStores()` truncates it between tests).

```bash
npm test
```

They cover CRUD, cross-visitor 404s, streaming assembly, resume from
`Last-Event-ID`, replay after buffer expiry, agent failure, cancellation, the 409
on a concurrent send, agent session cleanup on delete, message-length validation,
and onboarding-profile persistence. `tests/httpAgent.test.ts` additionally checks
the real wire format — request body, response fields, `/session/{id}`, `/health`
— against a throwaway local HTTP server (no PG/Redis needed for that file),
proving it matches `MUST_Academic_Assistant_Website_API_Handoff_V1.md`.
