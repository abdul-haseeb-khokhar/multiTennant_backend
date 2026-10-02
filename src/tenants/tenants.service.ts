import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import {QueryTenantDto} from './dto/query-tenant.dto';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  create(createTenantDto: CreateTenantDto) {
    return this.prisma.tenant.create({data: createTenantDto});
  }

  findAll(query: QueryTenantDto) {
    return this.prisma.tenant.findMany({
      skip: query.skip,
      take: query.take,
    });
  }

  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({where: {id}});
    if(!tenant) {
      throw new NotFoundException(`Tenant ${id} not found`);
    }
    return tenant;
  }

  async update(id: string, updateTenantDto: UpdateTenantDto) {
    try{
      return await this.prisma.tenant.update({ 
      where: {id},
      data: updateTenantDto
    });
    } catch (error) {
      if(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException(`Tenant ${id} not found`)
      }
      throw error;
    }
  }

  async remove(id: string) {
    try{
      return await this.prisma.tenant.delete({where: {id}});
    } catch(error) {
      if(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException(`Tenant ${id} not found`);
      }
      throw error;
    }
  }
}
