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
import { CurrentPlatformAdmin } from '../auth/current-platform-admin.decorator';
import { PlatformJwtAuthGuard } from '../auth/platform-jwt-auth.guard';
import type { PlatformUser } from '../auth/platform-jwt.strategy';
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
  @ApiOperation({ summary: 'Rename a tenant, change its plan or suspend it' })
  @ApiOkResponse({ type: Tenant })
  update(
    @Param('id') id: string,
    @Body() updateTenantDto: UpdateTenantDto,
    @CurrentPlatformAdmin() admin: PlatformUser,
  ) {
    return this.tenantsService.update(id, updateTenantDto, admin.adminId);
  }

  @Delete(':id')
  @ApiOkResponse({ type: Tenant })
  remove(@Param('id') id: string) {
    return this.tenantsService.remove(id);
  }
}
