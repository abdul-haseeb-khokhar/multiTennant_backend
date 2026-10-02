import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { EndCustomersService } from './end-customers.service';
import { CreateEndCustomerDto } from './dto/create-end-customer.dto';
import { UpdateEndCustomerDto } from './dto/update-end-customer.dto';
import { QueryEndCustomerDto } from './dto/query-end-customer.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('tenants/:tenantId/customers')
@UseGuards(JwtAuthGuard)
export class EndCustomersController {
  constructor(private readonly endCustomersService: EndCustomersService) {}

  @Post()
  create(@Param('tenantId') tenantId: string, @Body() dto: CreateEndCustomerDto) {
    return this.endCustomersService.create(tenantId, dto);
  }

  @Get()
  findAll(@Param('tenantId') tenantId: string, @Query() query: QueryEndCustomerDto) {
    return this.endCustomersService.findAll(tenantId, query);
  }

  @Get(':id')
  findOne(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.endCustomersService.findOne(tenantId, id);
  }

  @Patch(':id')
  update(@Param('tenantId') tenantId: string, @Param('id') id: string, @Body() dto: UpdateEndCustomerDto) {
    return this.endCustomersService.update(tenantId, id, dto);
  }

  @Delete(':id')
  remove(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.endCustomersService.remove(tenantId, id);
  }
}
