import { APICallError, generateText } from 'ai';
import type { ChatRequest, ChatResponse, ProviderName } from './types.js';
import type { ProviderRegistry } from './providers/index.js';
import { cacheKey, type ResponseCache } from './policies/cache.js';
import { withRetryAndFailover, type RetryOptions } from './policies/retry.js';
import { withTimeout, TimeoutError } from './policies/timeout.js';
import type { CircuitBreaker } from './policies/circuitBreaker.js';

/**
 * Whether a provider error is worth retrying (same provider) or failing over (next
 * provider). A deterministic 4xx (a bad model id, a validation or auth error) will
 * fail identically on every attempt AND on every other provider, so retrying it only
 * wastes latency and, worse, doubles the spend by failing it over. Only transient
 * errors are retryable:
 *   - our own TimeoutError is transient by definition (the call ran out of time);
 *   - the AI SDK sets `isRetryable` correctly (false for 4xx except 408/409/429,
 *     true for throttling / 5xx / network errors).
 * Any other (unclassified) error stays retryable, preserving the prior default.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (APICallError.isInstance(err)) return err.isRetryable === true;
  return true;
}

/** Everything the gateway core needs, injected so it stays testable without live keys. */
export interface GatewayDeps {
  providers: ProviderRegistry;
  defaultProvider: ProviderName;
  retry: RetryOptions;
  /** Optional response cache. When present, identical requests skip the provider call. */
  cache?: ResponseCache;
  /**
   * Model to use when failing over TO a given provider. A provider only joins the
   * failover chain if it has a fallback model here, because a request's model id
   * is provider-specific and won't be valid on a different provider.
   */
  fallbackModels?: Partial<Record<ProviderName, string>>;
  /** Per-provider-call deadline in ms. A timeout is retryable, so it triggers failover. */
  timeoutMs?: number;
  /**
   * Optional circuit breaker over the failover chain. Providers whose circuit is
   * open are skipped so the request fails fast to a healthy one instead of paying
   * retries + backoff + timeout on a provider that is already known to be down.
   */
  breaker?: CircuitBreaker;
}

/** Raised when a request names a provider that isn't in the registry. */
export class UnknownProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`Unknown provider: ${provider}`);
    this.name = 'UnknownProviderError';
  }
}

/** Raised when every provider in the failover chain has an open circuit. */
export class AllProvidersUnavailableError extends Error {
  constructor() {
    super('All providers are unavailable (circuit open)');
    this.name = 'AllProvidersUnavailableError';
  }
}

/** One target in the failover chain: which provider, and which model to ask it for. */
interface Step {
  provider: ProviderName;
  model: string;
}

/** Primary target first, then any other provider that has a configured fallback model. */
function buildChain(primary: ProviderName, model: string, deps: GatewayDeps): Step[] {
  const steps: Step[] = [{ provider: primary, model }];
  for (const name of Object.keys(deps.providers) as ProviderName[]) {
    if (name === primary) continue;
    const fallbackModel = deps.fallbackModels?.[name];
    if (fallbackModel) steps.push({ provider: name, model: fallbackModel });
  }
  return steps;
}

/**
 * Core orchestration for a non-streaming completion, composing the policies:
 * cache lookup → (retry with backoff → cross-provider failover) → cache store.
 * Rate limiting is applied upstream in the HTTP layer.
 */
export async function handleChat(req: ChatRequest, deps: GatewayDeps): Promise<ChatResponse> {
  const primary = req.provider ?? deps.defaultProvider;
  if (!deps.providers[primary]) throw new UnknownProviderError(primary);

  const key = deps.cache ? cacheKey(req, primary) : undefined;
  if (key && deps.cache) {
    const hit = await deps.cache.get(key);
    if (hit) return { ...hit, cached: true };
  }

  const run = async ({ provider, model }: Step): Promise<{ text: string; usage: ChatResponse['usage'] }> => {
    const impl = deps.providers[provider];
    if (!impl) throw new UnknownProviderError(provider);
    const call = (abortSignal?: AbortSignal) =>
      generateText({
        model: impl.languageModel(model),
        messages: req.messages,
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
        abortSignal,
      });
    // A stalled provider call becomes a fast, retryable failure (so it fails over)
    // rather than hanging until the serverless function's max duration.
    const generated = deps.timeoutMs ? await withTimeout(call, deps.timeoutMs) : await call();
    return {
      text: generated.text,
      usage: {
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
      },
    };
  };

  // Drop providers whose circuit is open so we fail fast to a healthy one. If every
  // provider is open, there is nothing healthy to try, so reject rather than probe.
  const breaker = deps.breaker;
  const chain = buildChain(primary, req.model, deps);
  const available = breaker ? chain.filter((step) => breaker.allow(step.provider)) : chain;
  if (available.length === 0) throw new AllProvidersUnavailableError();

  // Don't retry/fail over deterministic errors (a bad model id fails the same way
  // everywhere); an explicit deps.retry.isRetryable still wins if provided.
  const retry: RetryOptions = { ...deps.retry, isRetryable: deps.retry.isRetryable ?? isRetryableError };
  const outcome = await withRetryAndFailover(available, run, retry).catch((err: unknown) => {
    // Every attempted provider failed: record a failure for each.
    if (breaker) for (const step of available) breaker.recordFailure(step.provider);
    throw err;
  });

  if (breaker) {
    // The winner succeeded; every provider tried before it in the chain failed.
    const winnerIndex = available.indexOf(outcome.step);
    for (const step of available.slice(0, winnerIndex)) breaker.recordFailure(step.provider);
    breaker.recordSuccess(outcome.step.provider);
  }

  const response: ChatResponse = {
    provider: outcome.step.provider,
    model: outcome.step.model,
    text: outcome.result.text,
    usage: outcome.result.usage,
    cached: false,
  };

  if (key && deps.cache) await deps.cache.set(key, response);
  return response;
}
