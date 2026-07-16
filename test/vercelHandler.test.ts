import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { toNodeHandler } from '../api/index.js';

/**
 * These tests cover the Vercel Node adapter's cancellation contract: when the client
 * disconnects mid-stream, the adapter must cancel the response ReadableStream. Hono's
 * streamSSE turns that cancel into an `abort()`, which fires the surface's `onAbort`
 * and tears down the upstream provider call, so we stop paying for tokens nobody reads.
 * A regression here (the original code never cancelled) is invisible in staging but
 * bills real money in production, so it gets an explicit test.
 */

/** Minimal ServerResponse stand-in: an EventEmitter with the fields the adapter touches. */
function fakeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    writableEnded: boolean;
    written: unknown[];
    setHeader: (k: string, v: string) => void;
    write: (chunk: unknown) => boolean;
    end: () => void;
  };
  res.statusCode = 200;
  res.writableEnded = false;
  res.written = [];
  res.setHeader = () => {};
  res.write = (chunk) => {
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
  };
  return res;
}

const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await tick();
}

describe('toNodeHandler client-disconnect cancellation', () => {
  it('cancels the response stream (aborting upstream) when the client disconnects mid-stream', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: chunk-1\n\n'));
      },
      // Never produces more on its own: stays open until cancelled, standing in for a
      // long provider stream the client abandons partway through.
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const app = { fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) };
    const req = { method: 'POST', url: '/v1/chat', headers: { host: 'x' }, body: { stream: true } };
    const res = fakeRes();

    const done = toNodeHandler(app)(req as never, res as never);

    await waitFor(() => res.written.length === 1); // handler reached the pump and sent chunk 1
    expect(cancelled).toBe(false);

    res.emit('close'); // Node signals the client dropped before the response finished

    await done; // must unwind promptly, not hang on the still-open upstream stream
    expect(cancelled).toBe(true); // upstream cancelled -> provider call aborted, billing stops
  });

  it('does not cancel the stream on a normal completion', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: only\n\n'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const app = { fetch: async () => new Response(body) };
    const req = { method: 'POST', url: '/v1/chat', headers: { host: 'x' } };
    const res = fakeRes();

    await toNodeHandler(app)(req as never, res as never);
    res.emit('close'); // fires after end(); writableEnded is true, so the guard skips cancel

    expect(res.writableEnded).toBe(true);
    expect(cancelled).toBe(false);
  });
});
