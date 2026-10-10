import { isIP } from 'node:net';

/** Express `trust proxy` setting: false, a number of hops, or a list of addresses/names. */
export type TrustProxySetting = false | number | string[];

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_HOPS = 10;

function validEntry(entry: string): boolean {
  if (NAMED.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !isIP(address)) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  const max = isIP(address) === 6 ? 128 : 32;
  return /^\d{1,3}$/.test(prefix) && bits >= 0 && bits <= max;
}

/**
 * Parses `TRUST_PROXY`. Behind a reverse proxy (the dashboard's Next.js server, a load balancer)
 * every request comes from the proxy's address, so the audit log's `ip` and the per-IP rate limits
 * would all see the proxy. Telling Express how many proxies to trust makes `req.ip` the real
 * client from `X-Forwarded-For`. Accepted values:
 *  - unset, `false`, `0`, `off`, `no`: trust nobody (the default; `req.ip` is the socket address);
 *  - a number of hops, `1` to `10`: trust that many proxies in front of the app;
 *  - a comma-separated list of proxy addresses, CIDR ranges or `loopback`, `linklocal`,
 *    `uniquelocal`.
 * `true` is refused on purpose: it trusts the first `X-Forwarded-For` entry, which any client can
 * forge, so an attacker could pick the IP the audit log and the limits see.
 * Returns the setting, or throws `Error` with the reason (names only, no values to log).
 */
export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  const text = (value ?? '').trim().toLowerCase();
  if (['', 'false', '0', 'off', 'no'].includes(text)) return false;
  if (text === 'true') {
    throw new Error(
      'TRUST_PROXY=true is not allowed (it trusts a forgeable header): give the number of proxies in front of the app, or their addresses',
    );
  }
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops < 1 || hops > MAX_HOPS) {
      throw new Error(`TRUST_PROXY hops must be between 1 and ${MAX_HOPS}`);
    }
    return hops;
  }
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || !entries.every(validEntry)) {
    throw new Error(
      'TRUST_PROXY must be a number of proxies or a comma-separated list of addresses, CIDR ranges, loopback, linklocal or uniquelocal',
    );
  }
  return entries;
}
