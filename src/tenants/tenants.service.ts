import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  create(createTenantDto: CreateTenantDto) {
    return this.prisma.tenant.create({data: createTenantDto});
  }

  findAll() {
    return this.prisma.tenant.findMany();
  }

  findOne(id: string) {
    return this.prisma.tenant.findUnique({where: {id}});
  }

  update(id: string, updateTenantDto: UpdateTenantDto) {
    return this.prisma.tenant.update({ 
      where: {id},
      data: updateTenantDto
    });
  }

  remove(id: string) {
    return this.prisma.tenant.delete({where: {id}});
  }
}
