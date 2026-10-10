import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { DataUseService } from './data-use.service';
import { UpdateDataUseDto } from './dto/update-data-use.dto';
import { DataUse } from './entities/data-use.entity';

@ApiTags('data-use')
@ApiBearerAuth()
@Controller('tenants/:tenantId/data-use')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DataUseController {
  constructor(private readonly dataUse: DataUseService) {}

  @Get()
  @Roles('owner')
  @ApiOperation({
    summary: 'Consent to use conversations for model training (owner only)',
    description:
      "Default OFF. This only records the owner's choice; no training export exists (it needs legal review first).",
  })
  @ApiOkResponse({ type: DataUse })
  get(@Param('tenantId') tenantId: string) {
    return this.dataUse.get(tenantId);
  }

  @Put()
  @Roles('owner')
  @ApiOperation({
    summary: 'Grant or revoke consent (owner only)',
    description:
      '`enabled: true` needs `termsVersion`. Recorded with who accepted and when; revoking keeps the history and is audited. Admins and agents get 403 INSUFFICIENT_ROLE.',
  })
  @ApiOkResponse({ type: DataUse })
  update(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateDataUseDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.dataUse.update(tenantId, actor, dto);
  }
}
