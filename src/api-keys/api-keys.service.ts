import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiKey, Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/roles';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { normalizeOrigin } from '../common/validation/origin';
import { PrismaService } from '../prisma/prisma.service';
import { generateApiKey, hashApiKey } from './api-key.util';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { QueryApiKeyDto } from './dto/query-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';

/** Active (not revoked) keys a tenant may hold at once. */
export const MAX_ACTIVE_API_KEYS = 10;
/** `last_used_at` is written at most this often per key, so a busy widget does not write on every request. */
const LAST_USED_RESOLUTION_MS = 5 * 60_000;

type ApiKeyRow = Omit<ApiKey, 'keyHash'>;

/**
 * Widget and server keys (D8, B4). Only the sha256 of a key is stored and the full key is
 * returned once, by `create`. Everything is scoped by `tenantId`, which comes from the verified
 * staff token; the one exception is `resolveWidgetKey`, which is how a public key finds its
 * tenant in the first place.
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async create(tenantId: string, dto: CreateApiKeyDto, actor: AuthUser) {
    const type = dto.type ?? 'widget';
    if (type === 'widget') {
      // Chat must be part of the plan (and the account in good standing) to hand out chat keys.
      await this.entitlements.assert(tenantId, 'channel:chat');
    }
    const active = await this.prisma.apiKey.count({
      where: { tenantId, revokedAt: null },
    });
    if (active >= MAX_ACTIVE_API_KEYS) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.API_KEY_LIMIT_REACHED,
        `A tenant can have at most ${MAX_ACTIVE_API_KEYS} active API keys`,
      );
    }

    const { key, keyHash, keyPrefix } = generateApiKey(type);
    const allowedOrigins = this.cleanOrigins(dto.allowedOrigins ?? []);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.apiKey.create({
        data: {
          tenantId,
          type,
          name: dto.name,
          keyPrefix,
          keyHash,
          allowedOrigins,
          createdBy: actor.userId,
        },
        omit: { keyHash: true },
      });
      await this.audit.record(
        {
          tenantId,
          actor: { userId: actor.userId, role: actor.role },
          action: AuditAction.API_KEY_CREATED,
          targetType: 'api_key',
          targetId: row.id,
          // Never the key itself; the prefix and the origins identify it.
          after: {
            type,
            name: row.name,
            keyPrefix,
            allowedOrigins: row.allowedOrigins,
          },
        },
        tx,
      );
      return row;
    });
    return { ...created, key };
  }

  async findAll(tenantId: string, query: QueryApiKeyDto) {
    const page = resolvePage(query);
    const where: Prisma.ApiKeyWhereInput = {
      tenantId,
      ...(!query.includeRevoked && { revokedAt: null }),
    };
    const [data, total] = await Promise.all([
      this.prisma.apiKey.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        omit: { keyHash: true },
      }),
      this.prisma.apiKey.count({ where }),
    ]);
    return toPage(data, total, page);
  }

  async findOne(tenantId: string, id: string): Promise<ApiKeyRow> {
    const row = await this.prisma.apiKey.findFirst({
      where: { id, tenantId },
      omit: { keyHash: true },
    });
    if (!row) throw this.notFound(id);
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateApiKeyDto,
    actor: AuthUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.apiKey.findFirst({
        where: { id, tenantId },
        omit: { keyHash: true },
      });
      if (!before) throw this.notFound(id);
      if (before.revokedAt) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'A revoked API key cannot be changed',
        );
      }
      const data: Prisma.ApiKeyUpdateManyMutationInput = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.allowedOrigins !== undefined && {
          allowedOrigins: this.cleanOrigins(dto.allowedOrigins),
        }),
      };
      if (Object.keys(data).length === 0) return before;
      const result = await tx.apiKey.updateMany({
        where: { id, tenantId, revokedAt: null },
        data,
      });
      if (result.count === 0) throw this.notFound(id);
      const after = await tx.apiKey.findFirstOrThrow({
        where: { id, tenantId },
        omit: { keyHash: true },
      });
      await this.audit.record(
        {
          tenantId,
          actor: { userId: actor.userId, role: actor.role },
          action: AuditAction.API_KEY_UPDATED,
          targetType: 'api_key',
          targetId: id,
          before: { name: before.name, allowedOrigins: before.allowedOrigins },
          after: { name: after.name, allowedOrigins: after.allowedOrigins },
        },
        tx,
      );
      return after;
    });
  }

  /** Revoking is permanent and idempotent: a second call changes and records nothing. */
  async revoke(tenantId: string, id: string, actor: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.apiKey.updateMany({
        where: { id, tenantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const row = await tx.apiKey.findFirst({
        where: { id, tenantId },
        omit: { keyHash: true },
      });
      if (!row) throw this.notFound(id);
      if (result.count > 0) {
        await this.audit.record(
          {
            tenantId,
            actor: { userId: actor.userId, role: actor.role },
            action: AuditAction.API_KEY_REVOKED,
            targetType: 'api_key',
            targetId: id,
            before: { keyPrefix: row.keyPrefix, name: row.name },
          },
          tx,
        );
      }
      return row;
    });
  }

  // ---- used by the widget gateway ------------------------------------------------------------

  /**
   * Finds the active widget key for a key string a browser sent. Unknown, revoked and non-widget
   * keys all answer null, so a caller cannot tell which case it hit. This is how a public key
   * names its tenant; it is the one lookup that does not start from a `tenantId`.
   */
  async resolveWidgetKey(rawKey: string): Promise<ApiKeyRow | null> {
    const row = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(rawKey) },
      omit: { keyHash: true },
    });
    if (!row || row.type !== 'widget' || row.revokedAt) return null;
    return row;
  }

  /** Re-reads a key a widget token names, scoped to the token's tenant. */
  async findActiveWidgetKey(
    tenantId: string,
    keyId: string,
  ): Promise<ApiKeyRow | null> {
    return this.prisma.apiKey.findFirst({
      where: { id: keyId, tenantId, type: 'widget', revokedAt: null },
      omit: { keyHash: true },
    });
  }

  /** True when `origin` is allowed for the key (both sides normalised). */
  originAllowed(key: Pick<ApiKeyRow, 'allowedOrigins'>, origin: unknown) {
    const normalized = normalizeOrigin(origin);
    return normalized !== null && key.allowedOrigins.includes(normalized);
  }

  /** Records that the key was used, at most every few minutes; never fails the request. */
  touch(tenantId: string, keyId: string): void {
    const threshold = new Date(Date.now() - LAST_USED_RESOLUTION_MS);
    void this.prisma.apiKey
      .updateMany({
        where: {
          id: keyId,
          tenantId,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }],
        },
        data: { lastUsedAt: new Date() },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not update last_used_at: ${error instanceof Error ? error.message : 'unknown error'}`,
        ),
      );
  }

  private cleanOrigins(origins: string[]): string[] {
    const clean = origins.map((origin) => normalizeOrigin(origin));
    if (clean.some((origin) => origin === null)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'allowedOrigins contains an invalid origin',
      );
    }
    return [...new Set(clean as string[])];
  }

  private notFound(id: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.API_KEY_NOT_FOUND,
      `API key ${id} not found`,
    );
  }
}
