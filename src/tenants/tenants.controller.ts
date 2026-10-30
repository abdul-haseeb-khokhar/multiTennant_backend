import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformJwtAuthGuard } from '../auth/platform-jwt-auth.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { QueryTenantDto } from './dto/query-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { Tenant } from './entities/tenant.entity';
import { TenantsService } from './tenants.service';

@ApiTags('platform-admin')
@ApiBearerAuth()
@Controller('admin/tenants')
@UseGuards(PlatformJwtAuthGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @ApiOperation({ summary: 'List all tenants' })
  @ApiPaginatedResponse(Tenant)
  findAll(@Query() query: QueryTenantDto) {
    return this.tenantsService.findAll(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: Tenant })
  findOne(@Param('id') id: string) {
    return this.tenantsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a tenant or change its default language',
    description:
      '`plan` and `status` are no longer accepted (400 `USE_SUBSCRIPTION_ROUTES`): use `/admin/tenants/:id/subscription` (`activate`, `change-plan`, `suspend`, `unsuspend`, ...).',
  })
  @ApiOkResponse({ type: Tenant })
  update(@Param('id') id: string, @Body() updateTenantDto: UpdateTenantDto) {
    return this.tenantsService.update(id, updateTenantDto);
  }

  @Delete(':id')
  @ApiOkResponse({ type: Tenant })
  remove(@Param('id') id: string) {
    return this.tenantsService.remove(id);
  }
}
