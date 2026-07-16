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

export function authorize(presentedKey: string | undefined, allowlist: Set<string>): AuthResult {
  if (allowlist.size === 0) return { authorized: true, keyed: false };
  const keyed = presentedKey !== undefined && allowlist.has(presentedKey);
  return { authorized: keyed, keyed };
}
