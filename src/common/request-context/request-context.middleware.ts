import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

// Only accept a caller-supplied id when it is short and log-safe; otherwise make our own.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const logger = new Logger('HTTP');

/**
 * Gives every request an id (`req.id`, echoed in the `X-Request-Id` response header) and writes
 * one structured access-log line when the response finishes, including the `tenantId` that the
 * auth guard put on `req.user` (F3). Query strings are left out of the log: they can hold
 * personal data (F1). Registered with `app.use` (see `configureApp`) so it also covers 404s.
 */
export function requestContextMiddleware(
  req: Request & { id?: string; user?: any },
  res: Response,
  next: NextFunction,
) {
  const incoming = req.header(REQUEST_ID_HEADER);
  req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const path = (req.originalUrl ?? req.url).split('?')[0];
    if (path === '/health' || path.startsWith('/health/')) return;

    logger.log({
      message: 'request completed',
      requestId: req.id,
      tenantId: req.user?.tenantId,
      userId: req.user?.userId,
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    });
  });

  next();
}
