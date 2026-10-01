import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { TenantUsersService } from './tenant-users.service';
import { CreateTenantUserDto } from './dto/create-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';

@Controller('tenants/:tenantId/users')
export class TenantUsersController {
  constructor(private readonly tenantUsersService: TenantUsersService) {}

  @Post()
  create(@Param('tenantId') tenantId: string ,@Body() dto: CreateTenantUserDto) {
    return this.tenantUsersService.create(tenantId, dto);
  }

  @Get()
  findAll(@Param('tenantId') tenantId: string) {
    return this.tenantUsersService.findAll(tenantId);
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
