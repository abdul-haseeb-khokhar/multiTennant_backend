import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { AuditService } from './audit.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { AuditLog } from './entities/audit-log.entity';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('tenants/:tenantId/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditLogsController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Staff audit log, newest first (owner/admin)',
    description:
      'Filters: `actor` (user id), `action`, `from` and `to` (ISO-8601 instants).',
  })
  @ApiPaginatedResponse(AuditLog)
  findAll(
    @Param('tenantId') tenantId: string,
    @Query() query: QueryAuditLogDto,
  ) {
    return this.auditService.findAll(tenantId, query);
  }
}
