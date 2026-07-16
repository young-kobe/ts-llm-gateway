/** Raised when a provider call exceeds its time budget. Retryable, so it triggers failover. */
export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Provider call timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Run a provider call with a hard deadline. `run` is given an AbortSignal that
 * fires on timeout (so a well-behaved client cancels the upstream request); the
 * race also guarantees a fast rejection even if the underlying call ignores the
 * signal (e.g. a stall in credential resolution, which is not tied to the fetch).
 * A late rejection from the losing promise is swallowed so it can't surface as an
 * unhandled rejection.
 */
export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const call = run(controller.signal);
  void call.catch(() => {}); // if the timeout wins, ignore the call's later rejection

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
