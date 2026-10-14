import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';
import { TenantSettings } from './entities/tenant-settings.entity';
import { TenantSettingsService } from './tenant-settings.service';

/** The workspace's own settings (J3, J7). Platform admins use `/v1/admin/tenants` instead. */
@ApiTags('tenant')
@ApiBearerAuth()
@Controller('tenants/:tenantId')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantSettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'Name, slug, language and time zone of my workspace',
  })
  @ApiOkResponse({ type: TenantSettings })
  get(@CurrentUser() actor: AuthUser) {
    return this.settings.get(actor.tenantId);
  }

  @Patch()
  @Roles('owner')
  @ApiOperation({
    summary: 'Change name, default language, time zone or slug (owner only)',
    description:
      'Fields you leave out stay as they are. A slug rename needs a free slug (`409 SLUG_TAKEN` with `suggestions`), at most once every 30 days (`409 SLUG_CHANGE_TOO_SOON` with `nextAllowedAt`), keeps the old slug working at login for 30 days and reserves it for 90. Audited as `tenant.updated` and `tenant.slug_changed`.',
  })
  @ApiOkResponse({ type: TenantSettings })
  @ApiConflictResponse({
    description: '`SLUG_TAKEN` (with `suggestions`) or `SLUG_CHANGE_TOO_SOON`',
  })
  update(@CurrentUser() actor: AuthUser, @Body() dto: UpdateTenantSettingsDto) {
    return this.settings.update(actor, dto);
  }
}
