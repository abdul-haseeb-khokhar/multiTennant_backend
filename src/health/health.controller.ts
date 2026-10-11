import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { MailHealth } from '../mail/mail-health';
import { PrismaService } from '../prisma/prisma.service';

/** Unversioned and unauthenticated on purpose: load balancers and orchestrators call these. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailHealth,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness: the process is up' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: the database answers',
    description:
      'Also reports the mail provider: `mail.status` is `ok`, `degraded` after 3 failed deliveries in a row on this instance (a warning: readiness stays 200, because an email outage must not take the API out of the load balancer) or `not_configured` for the console mailer. Failure reasons are codes such as `quota_daily`, `test_mode_recipient`, `auth`, never an address.',
  })
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.SERVICE_UNAVAILABLE,
        'Database is not reachable',
      );
    }
    return { status: 'ok', database: 'up', mail: this.mail.snapshot() };
  }
}
