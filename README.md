# ts-llm-gateway

A minimal but real **LLM gateway proxy** in TypeScript/Node: one unified endpoint that
routes to multiple providers behind a single interface, with production policies layered on
top — rate limiting, retry/backoff with cross-provider failover, response caching, and
streaming with client-driven cancellation.

Built on Vercel's own stack: the [`ai`](https://www.npmjs.com/package/ai) SDK for the provider
abstraction, [`@ai-sdk/amazon-bedrock`](https://www.npmjs.com/package/@ai-sdk/amazon-bedrock)
(primary) and [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai) (failover) as
providers, and [Hono](https://hono.dev) for the HTTP layer.

> **Status:** Day 1 — skeleton + routing. Unified `POST /v1/chat` endpoint routes to both
> providers behind one interface, verified by an integration test that runs without live keys.
> Policies (rate limit, retry/failover, cache) and streaming land next.

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
  "usage": { "inputTokens": 7, "outputTokens": 11 }
}
```

### `GET /health`

Liveness check → `{ "ok": true }`.

## Architecture

```
POST /v1/chat ─▶ server.ts (Hono + zod validation)
                     │
                     ▼
                 gateway.ts ── route ─▶ providers/{bedrock,openai}.ts ─▶ AI SDK generateText
                     │
                     └── (Day 2) policies: rateLimit · retry+failover · cache
```

Providers hide behind a single `Provider` interface (`src/providers/index.ts`), so the gateway
never imports a concrete SDK. That seam is what makes routing, failover, and keyless testing
possible — tests inject a mock registry.

## Develop

```bash
npm install
npm test          # runs the integration suite with mock providers — no keys needed
npm run typecheck
cp .env.example .env   # fill in AWS + OpenAI creds to run against live providers
npm run dev
```

## Benchmarks

Real measured numbers land once the cache and failover paths exist.

- Cache hit vs. miss (p50 / p99): `TODO(metric)`
- Demonstrated Bedrock → OpenAI failover: `TODO(metric)`
