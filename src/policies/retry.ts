/**
 * Retry with exponential backoff, then failover across an ordered list of steps.
 *
 * Each "step" is a (provider, model) target: the primary is retried up to
 * `maxAttempts` times with growing (optionally jittered) delays, and if it stays
 * down the next step (the failover provider) takes over.
 *
 * `sleep` is injectable so tests assert the backoff schedule without real waits.
 */
export interface RetryOptions {
  /** Attempts per step before moving to the next step. Must be >= 1. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs: number;
  /** Injectable delay. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether an error is worth retrying the SAME step. Defaults to always true. */
  isRetryable?: (err: unknown) => boolean;
  /**
   * Spread each backoff over [delay/2, delay] to avoid a synchronized retry storm
   * (a "thundering herd" where many clients that failed together retry in lockstep).
   * Off by default so the deterministic schedule is easy to test.
   */
  jitter?: boolean;
  /** Injectable randomness in [0, 1) for jitter. Defaults to `Math.random`. */
  random?: () => number;
  /** Observability hook fired before each backoff wait. */
  onRetry?: (info: { stepIndex: number; attempt: number; delayMs: number; error: unknown }) => void;
}

export interface FailoverOutcome<S, T> {
  result: T;
  /** The step that ultimately succeeded. */
  step: S;
  /** Total run() invocations across all steps, useful for assertions/metrics. */
  totalAttempts: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff for a given 1-based attempt: base * 2^(attempt-1), capped at maxDelayMs. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

/** Equal-jitter spread of a delay into [delay/2, delay], rounded to whole ms. */
function jittered(delay: number, random: () => number): number {
  const half = delay / 2;
  return Math.round(half + random() * half);
}

/**
 * Run `steps` in order. Each step is retried up to `maxAttempts` times with
 * exponential backoff; when a step is exhausted (or errors non-retryably) the
 * next step is tried. Resolves with the first success, or rejects with the last
 * error if every step fails.
 */
export async function withRetryAndFailover<S, T>(
  steps: readonly S[],
  run: (step: S) => Promise<T>,
  options: RetryOptions,
): Promise<FailoverOutcome<S, T>> {
  if (steps.length === 0) throw new Error('withRetryAndFailover: no steps provided');

  const sleep = options.sleep ?? defaultSleep;
  const isRetryable = options.isRetryable ?? (() => true);
  let lastError: unknown;
  let totalAttempts = 0;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex] as S;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      totalAttempts++;
      try {
        return { result: await run(step), step, totalAttempts };
      } catch (err) {
        lastError = err;
        // Non-retryable → stop hammering this step; fail over to the next one.
        if (!isRetryable(err)) break;
        // Back off only if another attempt on THIS step remains.
        if (attempt < options.maxAttempts) {
          const base = backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs);
          const delayMs = options.jitter ? jittered(base, options.random ?? Math.random) : base;
          options.onRetry?.({ stepIndex, attempt, delayMs, error: err });
          await sleep(delayMs);
        }
      }
    }
  }

  throw lastError;
}
