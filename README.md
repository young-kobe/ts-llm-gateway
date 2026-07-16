# ts-llm-gateway

[![CI](https://github.com/young-kobe/ts-llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/young-kobe/ts-llm-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

A minimal but real **LLM gateway proxy** in TypeScript/Node: one unified endpoint that
routes to multiple providers behind a single interface, with production policies layered on
top: rate limiting, retry/backoff with cross-provider failover, response caching, and
streaming with client-driven cancellation.

Built on Vercel's own stack: the [`ai`](https://www.npmjs.com/package/ai) SDK for the provider
abstraction, [`@ai-sdk/amazon-bedrock`](https://www.npmjs.com/package/@ai-sdk/amazon-bedrock)
(primary) and [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai) (failover) as
providers, and [Hono](https://hono.dev) for the HTTP layer.

> **Status:** feature-complete. Unified `POST /v1/chat` routes to both providers behind one
> interface, wrapped in three production policies (per-key **rate limiting**, **retry with
> exponential backoff + cross-provider failover**, and an **LRU response cache**), plus **SSE
> token streaming with client-driven cancellation**, abuse guards (API-key auth, IP-based
> rate limiting, request caps), and a **live stats dashboard** (`/stats`). 41 tests (unit + HTTP
> integration) run without live keys; a benchmark harness measures the cache and failover paths.
> Deploy config for Vercel is included.

## Why this exists

Every feature here maps directly onto a piece of a production real-time streaming system
(RTSS) I built. The gateway is the same class of system, re-expressed as an LLM proxy:

| RTSS piece (production) | Gateway feature it becomes |
|---|---|
| Kinesis shard-polling backpressure / request admission | **Rate limiting**: token-bucket per API key/route |
| Retry/backoff on Kinesis throttling | **Retry + exponential backoff**, then **failover** to the secondary provider |
| Shard-consumer cancellation tokens | **Streaming abort**: client disconnect cancels the upstream call |
| Composite routing keys | **Provider/model routing** |
| SignalR streaming fan-out to dashboards | **SSE token streaming** to the client |

## API

### `POST /v1/chat`

Non-streaming chat completion.

```jsonc
// request
{
  "provider": "bedrock",          // optional; defaults to DEFAULT_PROVIDER
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "messages": [{ "role": "user", "content": "Hello" }],
  "temperature": 0.7,             // optional
  "maxTokens": 512                // optional
}
```

```jsonc
// response
{
  "provider": "bedrock",
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "text": "Hello! ...",
  "usage": { "inputTokens": 7, "outputTokens": 11 },
  "cached": false          // true when served from the response cache
}
```

`provider`/`model` reflect who *actually* served the response, so after a failover they name the
secondary. A `429` (with a `Retry-After` header) means the caller's rate-limit bucket is empty.

Send an API key via `x-api-key` (or a `Bearer` token) to get a per-key rate-limit bucket;
otherwise all callers share the `anonymous` bucket.

#### Streaming

Add `"stream": true` to get an SSE token stream instead of a single JSON body. Events are
`delta` (a token chunk) then a final `done` (with `provider`/`model`/`cached`/`usage`):

```
event: delta
data: {"type":"delta","text":"Hel"}

event: delta
data: {"type":"delta","text":"lo"}

event: done
data: {"type":"done","provider":"bedrock","model":"...","cached":false,"usage":{...}}
```

If the client disconnects, the gateway aborts the upstream provider call rather than letting it
run to completion. That is the RTSS cancellation-token bridge. (Streaming serves the primary
provider; retry/failover apply to the non-streaming path.)

### `GET /health`

Liveness check → `{ "ok": true }`.

### `GET /stats`

Live counters powering the dashboard on the landing page: request/success/error totals,
per-reason rejections, cache hit rate, failovers, per-provider served counts, token totals, and
provider-call latency p50/p99. Counters are per-instance (see
[Design decisions](#design-decisions--trade-offs)).

## Architecture

```mermaid
flowchart TD
    C([client]) --> BODY{body size ok?}
    BODY -- no --> E413[413 payload_too_large]
    BODY -- yes --> RL{rate limit<br/>key or IP}
    RL -- exhausted --> E429[429 + Retry-After]
    RL -- ok --> AUTH{authorized?}
    AUTH -- no --> E401[401 unauthorized]
    AUTH -- yes --> VAL{valid + caps?}
    VAL -- no --> E400[400 invalid_request]
    VAL -- yes --> CACHE{cache hit?}
    CACHE -- hit --> HIT[return cached<br/>no provider call]
    CACHE -- miss --> RETRY[retry + backoff]
    RETRY -- provider down --> FAIL[failover to next provider]
    RETRY --> GEN[AI SDK generateText / streamText]
    FAIL --> GEN
    GEN --> P[(Bedrock / OpenAI)]
    GEN --> STORE[cache store] --> RESP([response / SSE stream])

    subgraph "server.ts"
        BODY
        RL
        AUTH
        VAL
    end
    subgraph "gateway.ts + stream.ts"
        CACHE
        RETRY
        FAIL
        GEN
        STORE
    end
```

Providers hide behind a single `Provider` interface (`src/providers/index.ts`), so the gateway
never imports a concrete SDK. That seam is what makes routing, failover, and keyless testing
possible: tests inject a mock registry.

## Policies

Each policy is a standalone, unit-tested module in `src/policies/`, composed by the gateway in
the order above. All use injectable clocks / sleep so behavior is tested deterministically.

- **`rateLimit.ts`**: token bucket, one per caller (see [Abuse prevention](#abuse-prevention)
  for how the bucket key is chosen). Configurable capacity (burst) and refill rate; returns
  `429` + `Retry-After` when a bucket is empty.
- **`retry.ts`**: exponential backoff (`base · 2^n`, capped) per provider, then failover to the
  next provider in the chain. A provider only joins the chain if it has a fallback model
  configured, since model ids are provider-specific.
- **`cache.ts`**: LRU cache (optional TTL) keyed on a SHA-256 of the request identity
  (resolved provider + model + messages + params). A hit returns without any provider call.

Tuned via env vars; see `.env.example`.

## Abuse prevention

A public endpoint that spends money per call needs guarding. In-code (`src/server.ts`,
`src/policies/auth.ts`), the gateway does, in order:

1. **Body-size guard**: rejects oversized payloads (`413`) by `Content-Length` before parsing.
2. **Rate limiting**: buckets *authorized* callers by their validated key and everyone else by
   **client IP** (`x-forwarded-for`). It deliberately never buckets by the raw caller-supplied
   key, so an attacker can't rotate `x-api-key` to mint a fresh bucket per request.
3. **Auth gate**: when `GATEWAY_API_KEYS` is set, callers must present an allowlisted key
   (`x-api-key` or `Bearer`) or get `401`. Unset = open (local dev only).
4. **Request caps**: clamps `maxTokens` to `MAX_OUTPUT_TOKENS`, caps message count / content
   length, and optionally restricts models (`ALLOWED_MODELS`). Bounds the cost of any one request.

**Honest limitation on serverless:** the rate limiter and cache are in-memory, so on Vercel their
state is *per-instance* and resets on cold start, so they don't enforce a global ceiling across
instances. Treat them as best-effort. The durable backstops for a real deployment are:

- **Vercel Firewall / Attack Challenge Mode**: edge-level, cross-instance IP rate limiting.
- **Provider spend caps**: OpenAI usage limits + AWS Budgets, so abuse can't run up an unbounded
  bill even if every in-app guard is bypassed. Set these regardless.
- A shared store (Upstash Redis / Vercel KV) if you want per-key limits and cache hits to hold
  across instances.

## Design decisions & trade-offs

The interesting part of a gateway is what you deliberately chose *not* to do.

- **Providers behind one interface, injected.** The gateway core never imports a concrete SDK;
  it takes a `Provider` registry. That single seam is what makes routing, cross-provider failover,
  and **keyless testing** (mock registry) all fall out for free. Every test runs with no live keys.
- **Exact-match cache, not semantic.** Keys are a SHA-256 of the request identity (provider +
  model + messages + params). It's cheap, deterministic, and can never return a "close but wrong"
  answer; the cost is that only verbatim repeats hit (retries, idempotent re-sends, evals, load
  tests), not paraphrases. Semantic caching would trade correctness guarantees for hit rate; not
  worth it here.
- **In-memory cache & rate limiter are per-instance.** On Vercel's stateless, horizontally-scaled
  functions this is best-effort, not a global ceiling (see [Abuse prevention](#abuse-prevention)).
  Chosen because the durable path (a shared store or edge firewall) adds infra and per-request
  latency for benefit that only materializes at real traffic. The `ResponseCache` `get`/`set` seam
  makes a Redis-backed store a drop-in when that day comes.
- **Rate-limit bucketing by validated-key-or-IP**, never the raw caller-supplied header, since
  otherwise rotating `x-api-key` mints a fresh bucket per request and the limit is meaningless.
- **Streaming serves the primary provider only.** Retry/failover apply to the non-streaming path;
  failing over mid-stream after tokens are already sent to the client isn't safe, so it's out of
  scope by design rather than by omission.
- **`maxTokens` clamped before the cache key is computed**, so requests asking for 5000 vs 2000
  tokens normalize to the same capped value and can share a cache entry.

## Production next steps

Deliberately out of scope for this artifact, in rough priority order:

- **Shared state** (Upstash Redis / Vercel KV) for a global rate limit, cross-instance cache hits,
  and per-key usage quotas / billing.
- **Request coalescing (single-flight)**: collapse concurrent identical in-flight requests into
  one upstream call (the cache only dedupes *sequential* repeats, not simultaneous ones).
- **Per-call timeouts** on the provider request, feeding the retry/failover path.
- **Usage to cost accounting**: tokens × per-model price, surfaced per request and in aggregate.
- **Structured logging + tracing** (request id, provider, latency, cache hit, tokens).

## Develop

```bash
npm install
npm test          # runs the integration suite with mock providers (no keys needed)
npm run typecheck
cp .env.example .env   # fill in AWS + OpenAI creds to run against live providers
npm run dev            # serves the API + landing page/dashboard at http://localhost:8787
```

`npm run dev` also serves `public/` (landing page + live dashboard) so the full experience is
viewable locally; in production Vercel serves those static files itself.

## Benchmarks

Measured with `npm run bench`. **Honesty note:** these run without live provider keys, against
a mock backend with a fixed injected latency (120 ms). So the numbers are real measurements of
*the gateway itself*: cache-hit vs. cache-miss overhead and failover behavior, not of any real
model. Re-run against live Bedrock/OpenAI after deploy for end-to-end provider latency.

Simulated 120 ms backend, 200 iterations:

| Path | p50 | p99 | mean |
|---|---|---|---|
| cache **miss** (full backend round-trip) | 120.78 ms | 121.69 ms | 120.93 ms |
| cache **hit** (in-process hash + LRU lookup) | 0.003 ms | 0.012 ms | 0.004 ms |

- A miss costs the full backend round-trip; a hit avoids the provider call entirely and is
  served in-process at sub-millisecond p99.
- **Failover demo:** with the primary forced down, the request failed over and was **served by
  `openai` in 413 ms** (two failed primary attempts × 120 ms + 50 ms backoff + one 120 ms
  secondary call).

## Deploy (Vercel)

`api/index.ts` wraps the Hono app in the Node.js Vercel adapter
(`@hono/node-server/vercel`, not `hono/vercel`, which is the Edge/Web adapter) and
`vercel.json` rewrites all routes to that one function. `framework: null` keeps Vercel from
also treating `src/` as a server entrypoint. To ship it under your own account:

```bash
npm i -g vercel
vercel                 # link + deploy a preview
# set env vars (AWS_*, OPENAI_API_KEY, *_FALLBACK_MODEL, policy knobs) in the dashboard
vercel --prod          # deploy production, capture the live URL
```

- Live URL: https://ts-llm-gateway.vercel.app/

## License

[MIT](./LICENSE) © Kobe Young
