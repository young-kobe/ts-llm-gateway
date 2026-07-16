import { describe, it, expect } from 'vitest';
import { authorize } from '../src/policies/auth.js';

describe('authorize', () => {
  it('is open (but not keyed) when the allowlist is empty', () => {
    expect(authorize(undefined, new Set())).toEqual({ authorized: true, keyed: false });
    expect(authorize('anything', new Set())).toEqual({ authorized: true, keyed: false });
  });

  it('authorizes only keys in the allowlist', () => {
    const allowlist = new Set(['k1', 'k2']);
    expect(authorize('k1', allowlist)).toEqual({ authorized: true, keyed: true });
    expect(authorize('k2', allowlist)).toEqual({ authorized: true, keyed: true });
    expect(authorize('nope', allowlist)).toEqual({ authorized: false, keyed: false });
    expect(authorize(undefined, allowlist)).toEqual({ authorized: false, keyed: false });
  });
});
