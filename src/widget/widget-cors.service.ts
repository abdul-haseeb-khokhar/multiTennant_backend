import { Injectable } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { IncomingMessage } from 'node:http';
import type { Response } from 'express';
import { normalizeOrigin } from '../common/validation/origin';
import { PrismaService } from '../prisma/prisma.service';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import { WIDGET_ALLOWED_HEADERS } from './widget.constants';

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const MAX_CACHED_ORIGINS = 500;

/** True for `/v1/widget` and everything below it (also with a query string). */
export function isWidgetPath(url: string | undefined, prefix: string) {
  const path = (url ?? '').split('?')[0];
  const base = `/${prefix}/widget`;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Per-tenant CORS for the widget routes (D8). The dashboard keeps one origin (`FRONTEND_URL`);
 * the widget runs on customers' websites, so what is allowed depends on the widget key, and the
 * key is not known when the browser sends its preflight (no body, no custom headers yet).
 *
 *  - PREFLIGHT (`OPTIONS`): the origin is answered with CORS headers only if it is on the allow-list
 *    of at least one active widget key, never `*`, never credentials. This says "some tenant
 *    allows this site"; it grants nothing by itself.
 *  - ACTUAL requests: no header is added here. The gateway adds
 *    `Access-Control-Allow-Origin` itself, only after the key and origin matched for THIS key
 *    (`applyWidgetCors`), so another tenant's site can never read this tenant's responses.
 *
 * The lookup crosses tenants on purpose (it asks "does any key list this origin?" and returns a
 * boolean); it is cached briefly and the preflight rate limit bounds how often an unauthenticated
 * caller can reach the database.
 */
@Injectable()
export class WidgetCorsService {
  private readonly cache = new Map<
    string,
    { allowed: boolean; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: WidgetRateLimitService,
  ) {}

  /** Forgets cached answers (tests; a key change otherwise shows within a minute). */
  clearCache() {
    this.cache.clear();
  }

  /** CORS options for one request to a widget route (used as the `enableCors` delegate). */
  async optionsFor(
    request: IncomingMessage & { ip?: string },
  ): Promise<CorsOptions> {
    const refuse: CorsOptions = { origin: false };
    const isPreflight =
      request.method === 'OPTIONS' &&
      typeof request.headers['access-control-request-method'] === 'string';
    if (!isPreflight) return refuse;

    const origin = normalizeOrigin(request.headers.origin);
    if (!origin) return refuse;
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    if (!this.limits.preflightAllowed(ip)) return refuse;
    if (!(await this.someKeyAllows(origin))) return refuse;

    return {
      origin,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: WIDGET_ALLOWED_HEADERS,
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      credentials: false,
      maxAge: 600,
      optionsSuccessStatus: 204,
    };
  }

  private async someKeyAllows(origin: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > now) return cached.allowed;

    const key = await this.prisma.apiKey.findFirst({
      where: {
        type: 'widget',
        revokedAt: null,
        allowedOrigins: { has: origin },
      },
      select: { id: true },
    });
    if (this.cache.size >= MAX_CACHED_ORIGINS) {
      // Random origins from a hostile caller must not grow the map: start over.
      this.cache.clear();
    }
    this.cache.set(origin, {
      allowed: key !== null,
      expiresAt: now + (key ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    return key !== null;
  }
}

/**
 * Lets the browser read this response: call it once the key and the origin have been checked
 * together. The origin is echoed exactly (never `*`), there are no credentials, and `Vary: Origin`
 * keeps caches from serving one site's answer to another.
 */
export function applyWidgetCors(response: Response, origin: string) {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.vary('Origin');
  response.setHeader(
    'Access-Control-Expose-Headers',
    'X-Request-Id, Retry-After',
  );
}
