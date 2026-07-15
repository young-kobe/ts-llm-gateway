# ts-llm-gateway

A minimal but real **LLM gateway proxy** in TypeScript/Node: one unified endpoint that
routes to multiple providers behind a single interface, with production policies layered on
top — rate limiting, retry/backoff with cross-provider failover, response caching, and
streaming with client-driven cancellation.

Built on Vercel's own stack: the [`ai`](https://www.npmjs.com/package/ai) SDK for the provider
abstraction, [`@ai-sdk/amazon-bedrock`](https://www.npmjs.com/package/@ai-sdk/amazon-bedrock)
(primary) and [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai) (failover) as
providers, and [Hono](https://hono.dev) for the HTTP layer.

> **Status:** Day 2 — policies. Unified `POST /v1/chat` routes to both providers behind one
> interface, now wrapped in three production policies: per-key **rate limiting**, **retry with
> exponential backoff + cross-provider failover**, and an **LRU response cache**. Each is unit
> tested, plus HTTP-level integration tests, all running without live keys. Streaming,
> benchmarks, and deploy land next.

## Why this exists

Every feature here maps directly onto a piece of a production real-time streaming system
(RTSS) I built. The gateway is the same class of system, re-expressed as an LLM proxy:

| RTSS piece (production) | Gateway feature it becomes |
|---|---|
| Kinesis shard-polling backpressure / request admission | **Rate limiting** — token-bucket per API key/route |
| Retry/backoff on Kinesis throttling | **Retry + exponential backoff**, then **failover** to the secondary provider |
| Shard-consumer cancellation tokens | **Streaming abort** — client disconnect cancels the upstream call |
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

### `GET /health`

Liveness check → `{ "ok": true }`.

## Architecture

```
POST /v1/chat
     │
     ▼
 server.ts ── rate limit (429) ── zod validation (400)
     │
     ▼
 gateway.ts ── cache lookup ──hit──▶ return (no provider call)
     │  miss
     ▼
 retry + backoff ──exhausted──▶ failover to next provider
     │
     ▼
 providers/{bedrock,openai}.ts ─▶ AI SDK generateText ─▶ cache store
```

Providers hide behind a single `Provider` interface (`src/providers/index.ts`), so the gateway
never imports a concrete SDK. That seam is what makes routing, failover, and keyless testing
possible — tests inject a mock registry.

## Policies

Each policy is a standalone, unit-tested module in `src/policies/`, composed by the gateway in
the order above. All use injectable clocks / sleep so behavior is tested deterministically.

- **`rateLimit.ts`** — token bucket per API key (`x-api-key`, else bearer token, else
  `anonymous`). Configurable capacity (burst) and refill rate; returns `429` + `Retry-After`
  when a bucket is empty.
- **`retry.ts`** — exponential backoff (`base · 2^n`, capped) per provider, then failover to the
  next provider in the chain. A provider only joins the chain if it has a fallback model
  configured, since model ids are provider-specific.
- **`cache.ts`** — LRU cache (optional TTL) keyed on a SHA-256 of the request identity
  (resolved provider + model + messages + params). A hit returns without any provider call.

Tuned via env vars — see `.env.example`.

## Develop

```bash
npm install
npm test          # runs the integration suite with mock providers — no keys needed
npm run typecheck
cp .env.example .env   # fill in AWS + OpenAI creds to run against live providers
npm run dev
```

## Benchmarks

The cache and failover paths now exist; real measured numbers land in Day 3 alongside the
streaming work and a small bench harness.

- Cache hit vs. miss (p50 / p99): `TODO(metric)`
- Demonstrated Bedrock → OpenAI failover: `TODO(metric)`
