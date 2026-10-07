import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEndCustomerDto } from './dto/create-end-customer.dto';
import { QueryEndCustomerDto } from './dto/query-end-customer.dto';
import { UpdateEndCustomerDto } from './dto/update-end-customer.dto';

@Injectable()
export class EndCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateEndCustomerDto) {
    try {
      return await this.prisma.endCustomer.create({
        data: {
          tenantId,
          externalId: dto.externalId,
          name: dto.name,
          metadata: dto.metadata as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2003')) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.TENANT_NOT_FOUND,
          `Tenant ${tenantId} not found`,
        );
      }
      if (isPrismaError(error, 'P2002')) {
        throw this.externalIdTaken();
      }
      throw error;
    }
  }

  async findAll(tenantId: string, query: QueryEndCustomerDto) {
    const page = resolvePage(query);
    const [data, total] = await Promise.all([
      this.prisma.endCustomer.findMany({
        where: { tenantId },
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.endCustomer.count({ where: { tenantId } }),
    ]);
    return toPage(data, total, page);
  }

  async findOne(tenantId: string, id: string) {
    const customer = await this.prisma.endCustomer.findFirst({
      where: { id, tenantId },
    });
    if (!customer) {
      throw this.notFound(id);
    }
    return customer;
  }

  async update(tenantId: string, id: string, dto: UpdateEndCustomerDto) {
    await this.findOne(tenantId, id);
    try {
      return await this.prisma.endCustomer.update({
        where: { id, tenantId },
        data: {
          externalId: dto.externalId,
          name: dto.name,
          metadata: dto.metadata as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw this.externalIdTaken();
      }
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    try {
      return await this.prisma.endCustomer.delete({ where: { id, tenantId } });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  private notFound(id: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.CUSTOMER_NOT_FOUND,
      `End customer ${id} not found`,
    );
  }

  private externalIdTaken() {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.EXTERNAL_ID_TAKEN,
      'An end customer with this external id already exists for this tenant',
    );
  }
}
