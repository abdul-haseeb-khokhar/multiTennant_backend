/**
 * The claims that say when a staff or platform token was issued. `iat` is the JWT library's own
 * claim, in whole seconds. `iatMs` is ours, in milliseconds, added by `SessionTokenService` and the
 * platform login so a logout or password change can be compared to a token exactly: with whole
 * seconds a login right after a logout in the same second could not be told from a token issued
 * just before it.
 */
export interface IssuedAtClaims {
  iat?: number;
  iatMs?: number;
}

/**
 * True when the token was issued before `instant` (a logout, `tokens_valid_after`, or a password
 * change) and must be refused.
 *
 * - With `iatMs` the comparison is exact: a token issued at or before the instant is refused, one
 *   issued after it (a login right after the logout) passes.
 * - Without it (tokens signed before Phase 3C, still valid for up to a day) only `iat` is known, in
 *   whole seconds, so a token is refused only when its second is earlier than the instant's: that
 *   keeps a login in the same second working, at the price that an old token issued in the very
 *   second of the logout survives it. They expire within a day.
 * - A token with neither claim cannot be placed in time and is refused.
 */
export function wasIssuedBefore(
  claims: IssuedAtClaims,
  instant: Date,
): boolean {
  if (typeof claims.iatMs === 'number') {
    return claims.iatMs <= instant.getTime();
  }
  if (typeof claims.iat !== 'number') {
    return true;
  }
  return claims.iat < Math.floor(instant.getTime() / 1000);
}
