import { createHash, randomBytes } from 'node:crypto';

/**
 * Single-use secrets for invites, password resets and email verification. The token goes into
 * the emailed link; only its sha256 is stored, so a database leak does not yield usable links.
 * 32 random bytes make a token unguessable, which is why a plain (unsalted) hash is enough.
 */
export function generateToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
