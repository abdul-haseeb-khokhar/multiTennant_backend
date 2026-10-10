import { Injectable } from '@nestjs/common';
import type { DataUseConsent } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { Clock } from '../billing/clock';
import { PrismaService } from '../prisma/prisma.service';
import { MODEL_TRAINING_PURPOSE } from './data-use.constants';
import { UpdateDataUseDto } from './dto/update-data-use.dto';

/**
 * Per-tenant consent to use de-identified conversations for our own model training (I11).
 * One row per (tenant, purpose); no row means "off". Only records the choice, with the terms
 * version, who accepted and when; every change is audited. NO training export exists or is
 * implied: that needs legal review first (see data-use.constants.ts).
 */
@Injectable()
export class DataUseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async get(tenantId: string) {
    const row = await this.prisma.dataUseConsent.findUnique({
      where: {
        tenantId_purpose: { tenantId, purpose: MODEL_TRAINING_PURPOSE },
      },
    });
    return toView(row);
  }

  async update(tenantId: string, actor: AuthUser, dto: UpdateDataUseDto) {
    const where = {
      tenantId_purpose: { tenantId, purpose: MODEL_TRAINING_PURPOSE },
    };
    const now = this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.dataUseConsent.findUnique({ where });
      const base = {
        tenantId,
        actor: { userId: actor.userId, role: actor.role },
        targetType: 'data_use',
        targetId: MODEL_TRAINING_PURPOSE,
      };

      if (dto.enabled) {
        const termsVersion = dto.termsVersion!;
        if (
          existing?.status === 'granted' &&
          existing.termsVersion === termsVersion
        ) {
          return existing;
        }
        const granted = await tx.dataUseConsent.upsert({
          where,
          create: {
            tenantId,
            purpose: MODEL_TRAINING_PURPOSE,
            status: 'granted',
            termsVersion,
            acceptedBy: actor.userId,
            acceptedAt: now,
          },
          update: {
            status: 'granted',
            termsVersion,
            acceptedBy: actor.userId,
            acceptedAt: now,
            revokedAt: null,
          },
        });
        await this.audit.record(
          {
            ...base,
            action: AuditAction.DATA_USE_GRANTED,
            before: { status: existing ? existing.status : 'off' },
            after: { status: 'granted', termsVersion },
          },
          tx,
        );
        return granted;
      }

      if (!existing || existing.status !== 'granted') {
        return existing;
      }
      const revoked = await tx.dataUseConsent.update({
        where: { id: existing.id, tenantId },
        data: { status: 'revoked', revokedAt: now },
      });
      await this.audit.record(
        {
          ...base,
          action: AuditAction.DATA_USE_REVOKED,
          before: { status: 'granted', termsVersion: existing.termsVersion },
          after: { status: 'revoked' },
        },
        tx,
      );
      return revoked;
    });
    return toView(row);
  }
}

function toView(row: DataUseConsent | null) {
  return {
    purpose: MODEL_TRAINING_PURPOSE,
    enabled: row?.status === 'granted',
    status: row ? row.status : 'off',
    termsVersion: row?.termsVersion ?? null,
    acceptedBy: row?.acceptedBy ?? null,
    acceptedAt: row?.acceptedAt ?? null,
    revokedAt: row?.revokedAt ?? null,
  };
}
