import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { TenantUsersService } from './tenant-users.service';
import { CreateTenantUserDto } from './dto/create-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';
import { QueryTenantDto } from '../tenants/dto/query-tenant.dto';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('tenants/:tenantId/users')
@UseGuards(JwtAuthGuard)
export class TenantUsersController {
  constructor(private readonly tenantUsersService: TenantUsersService) {}

  @Post()
  create(@Param('tenantId') tenantId: string ,@Body() dto: CreateTenantUserDto) {
    return this.tenantUsersService.create(tenantId, dto);
  }

  @Get()
  findAll(@Param('tenantId') tenantId: string, @Query() query: QueryTenantDto) {
    return this.tenantUsersService.findAll(tenantId, query);
  }

  @Get(':id')
  findOne(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.tenantUsersService.findOne(tenantId, id);
  }

  @Patch(':id')
  update(@Param('tenantId') tenantId: string, @Param('id') id: string, @Body() dto: UpdateTenantUserDto) {
    return this.tenantUsersService.update(tenantId, id, dto);
  }

  @Delete(':id')
  remove(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.tenantUsersService.remove(tenantId, id);
  }
}
