import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * API-key authorization for the gateway.
 *
 * When the allowlist is empty, authentication is disabled and the endpoint is open
 * (fine for local dev; NOT recommended for a public deploy). When it's non-empty,
 * a request must present a key that's in the set.
 */
export interface AuthResult {
  /** Whether the request may proceed. */
  authorized: boolean;
  /** Whether the presented key is a recognized allowlisted key (used for rate-limit bucketing). */
  keyed: boolean;
}

/** SHA-256 digest, so comparisons run over fixed 32-byte buffers regardless of key length. */
function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export function authorize(presentedKey: string | undefined, allowlist: Set<string>): AuthResult {
  if (allowlist.size === 0) return { authorized: true, keyed: false };
  if (presentedKey === undefined) return { authorized: false, keyed: false };

  // Constant-time membership test: compare the presented key against every allowed
  // key with `timingSafeEqual` over equal-length digests, and never break early, so
  // response time leaks neither whether a key matched nor its length/prefix (which a
  // plain `Set.has` / `===` would, enabling a byte-at-a-time key-recovery attack).
  const presented = digest(presentedKey);
  let keyed = false;
  for (const key of allowlist) {
    if (timingSafeEqual(presented, digest(key))) keyed = true;
  }
  return { authorized: keyed, keyed };
}
