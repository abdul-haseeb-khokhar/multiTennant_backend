import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { AgentConfigService } from './agent-config.service';

/** Pulls per tenant and minute: the engine pulls once per call and caches for 60 s, so this is generous. */
export const CONFIG_PULLS_PER_MINUTE = 600;
const WINDOW_MS = 60_000;
/** The engine may cache the answer for this long (L7). */
export const CONFIG_MAX_AGE_SECONDS = 60;

/**
 * `GET /internal/tenants/{tenantId}/agents/{agentId}/config`: the engine pulls an agent's settings at
 * the start of every call (L7). Service to service, so it lives OUTSIDE `/v1` (see `configureApp`),
 * is not in the public OpenAPI document and must only be reachable on the private network. The
 * contract is `docs/contracts/backend-internal.openapi.yaml`. The tenant is the verified path
 * segment AND the agent must belong to it (an agent of another tenant is 404 like one that does not
 * exist). The body holds forwarding phone numbers: it is never logged.
 */
@ApiExcludeController()
@Controller('internal/tenants/:tenantId/agents/:agentId/config')
@UseGuards(InternalTokenGuard)
export class InternalAgentConfigController {
  constructor(
    private readonly config: AgentConfigService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async get(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
    @Query('version') versionParam: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const limit = this.limiter.hit(
      `agent-config:${tenantId}`,
      CONFIG_PULLS_PER_MINUTE,
      WINDOW_MS,
    );
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds);

    const version = parseVersion(versionParam);
    const pulled = await this.config.pull(tenantId, agentId, version);

    response.setHeader('ETag', pulled.etag);
    response.setHeader(
      'Cache-Control',
      `private, max-age=${CONFIG_MAX_AGE_SECONDS}`,
    );
    if (matchesEtag(request.headers['if-none-match'], pulled.etag)) {
      response.status(HttpStatus.NOT_MODIFIED);
      return;
    }
    return {
      tenantId: pulled.tenantId,
      agentId: pulled.agentId,
      version: pulled.version,
      status: pulled.status,
      config: pulled.config,
    };
  }
}

function parseVersion(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (
    !/^\d{1,10}$/.test(raw) ||
    Number(raw) < 1 ||
    Number(raw) > 2_147_483_647
  ) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      'version must be a positive whole number',
    );
  }
  return Number(raw);
}

/** `If-None-Match`: `*`, or a comma-separated list of (weak or strong) entity tags. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .includes(etag);
}
