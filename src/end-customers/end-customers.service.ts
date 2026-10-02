import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryEndCustomerDto } from './dto/query-end-customer.dto';
import { CreateEndCustomerDto } from './dto/create-end-customer.dto';
import { UpdateEndCustomerDto } from './dto/update-end-customer.dto';
import { skip } from 'node:test';

@Injectable()
export class EndCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateEndCustomerDto) {
    try {
      return await this.prisma.endCustomer.create({
        data: { tenantId, externalId: dto.externalId, name: dto.name, metadata: dto.metadata as Prisma.InputJsonValue,}
      });
    } catch (error) {
      if(error instanceof Prisma.PrismaClientKnownRequestError) {
        if(error.code === 'P2003') {
          throw new NotFoundException(`Tenant ${tenantId} not found`)
        }
        if (error.code === 'P2002') {
          throw new ConflictException('An end customer with this external id already exists for this tenant');
        }
      }

      throw error;
    }
    
  }

  findAll(tenantId: string, query: QueryEndCustomerDto) {
    return this.prisma.endCustomer.findMany({
      where: {tenantId},
      skip: query.skip,
      take: query.take
    });
  }

  async findOne(tenantId: string, id: string) {
    const customer = await this.prisma.endCustomer.findFirst({
      where: {id, tenantId}
    });
    if(!customer) {
      throw new NotFoundException(`End customer ${id} not found`)
    }
    return customer;
  }

async update(tenantId: string, id: string, dto: UpdateEndCustomerDto) {
    await this.findOne(tenantId, id);
    return this.prisma.endCustomer.update({
      where: {id}, 
      data: {
        externalId: dto.externalId,
        name: dto.name,
        metadata: dto.metadata as Prisma.InputJsonValue,
      }
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.endCustomer.delete({
      where: {id}
    })
  }
}
