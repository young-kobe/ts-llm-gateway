/**
 * Benchmark harness for the gateway's policy paths.
 *
 * Honesty note: this runs WITHOUT live provider keys, against a mock backend with
 * a fixed injected latency. The numbers are therefore real measurements of the
 * gateway itself — cache-hit vs. cache-miss overhead, and failover behavior — not
 * of any real model. Re-run against live Bedrock/OpenAI after deploy to get
 * end-to-end provider latency.
 *
 *   npm run bench            # default 120ms backend, 200 iterations
 *   BACKEND_LATENCY_MS=250 BENCH_ITERATIONS=500 npm run bench
 */
import { performance } from 'node:perf_hooks';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { handleChat, type GatewayDeps } from '../src/gateway.js';
import { ResponseCache } from '../src/policies/cache.js';
import type { ChatRequest } from '../src/types.js';
import type { Provider, ProviderRegistry } from '../src/providers/index.js';

const BACKEND_LATENCY_MS = Number(process.env.BACKEND_LATENCY_MS ?? 120);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 200);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A mock model that simulates a provider taking `latencyMs` per call. */
function backend(latencyMs: number): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      await sleep(latencyMs);
      return {
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        content: [{ type: 'text' as const, text: 'ok' }],
        warnings: [],
      };
    },
  });
}

function throwingBackend(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      await sleep(BACKEND_LATENCY_MS);
      throw new Error('primary provider down');
    },
  });
}

function registryOf(bedrock: LanguageModelV3, openai: LanguageModelV3): ProviderRegistry {
  const provider = (name: Provider['name'], model: LanguageModelV3): Provider => ({ name, languageModel: () => model });
  return { bedrock: provider('bedrock', bedrock), openai: provider('openai', openai) };
}

function req(nonce: number): ChatRequest {
  return { model: 'bench-model', messages: [{ role: 'user', content: `prompt ${nonce}` }] };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function stats(samples: number[]): { p50: number; p99: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  return { p50: percentile(sorted, 50), p99: percentile(sorted, 99), mean };
}

const fmt = (n: number) => n.toFixed(3).padStart(9);

async function main() {
  const deps: GatewayDeps = {
    providers: registryOf(backend(BACKEND_LATENCY_MS), backend(BACKEND_LATENCY_MS)),
    defaultProvider: 'bedrock',
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    cache: new ResponseCache({ maxEntries: ITERATIONS + 10 }),
  };

  // Cache MISS: every request is unique, so each hits the backend.
  const miss: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t = performance.now();
    await handleChat(req(i), deps);
    miss.push(performance.now() - t);
  }

  // Cache HIT: warm one entry, then repeat it.
  await handleChat(req(-1), deps);
  const hit: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t = performance.now();
    const r = await handleChat(req(-1), deps);
    if (!r.cached) throw new Error('bench bug: expected a cache hit');
    hit.push(performance.now() - t);
  }

  // Failover: primary down, secondary serves.
  const failoverDeps: GatewayDeps = {
    providers: registryOf(throwingBackend(), backend(BACKEND_LATENCY_MS)),
    defaultProvider: 'bedrock',
    fallbackModels: { openai: 'bench-model' },
    retry: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 200 },
  };
  const tf = performance.now();
  const failoverResult = await handleChat(req(1), failoverDeps);
  const failoverMs = performance.now() - tf;

  const missStats = stats(miss);
  const hitStats = stats(hit);

  console.log(`\nGateway benchmark — simulated ${BACKEND_LATENCY_MS}ms backend, ${ITERATIONS} iterations\n`);
  console.log('                      p50 (ms)    p99 (ms)   mean (ms)');
  console.log(`  cache miss         ${fmt(missStats.p50)}   ${fmt(missStats.p99)}  ${fmt(missStats.mean)}`);
  console.log(`  cache hit          ${fmt(hitStats.p50)}   ${fmt(hitStats.p99)}  ${fmt(hitStats.mean)}`);
  console.log(
    `\n  A miss costs the full backend round-trip (~${BACKEND_LATENCY_MS}ms); a hit is served ` +
      `entirely in-process (hash + LRU lookup) at sub-millisecond p99.`,
  );
  console.log(`  failover: primary down → served by ${failoverResult.provider} (${failoverResult.model}) in ${failoverMs.toFixed(0)}ms\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
