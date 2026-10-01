import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateTenantUserDto } from './dto/create-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';
import { Prisma } from '@prisma/client';
import * as bcrypt from "bcrypt";
import { PrismaService } from '../prisma/prisma.service';

const SALT_ROUNDS = 10;

@Injectable()
export class TenantUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string ,dto: CreateTenantUserDto) {
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    try {
      return await this.prisma.tenantUser.create({
        data: {tenantId, email: dto.email, passwordHash, role: dto.role},
        omit: {passwordHash: true}
      })
    } catch (error) {
      if(error instanceof Prisma.PrismaClientKnownRequestError) {
        if(error.code === 'P2003') {
          throw new NotFoundException(`Tenant ${tenantId} not found`);
        }
        if(error.code === 'P2002') {
          throw new ConflictException('A user with this email already exists for this tenant');
        }
      }
      throw error;
    }
  }

  findAll(tenantId: string) {
    return this.prisma.tenantUser.findMany({
      where: {tenantId},
      omit: {passwordHash: true},
    })
  }

  async findOne(tenantId: string, id: string) {
    const user = await this.prisma.tenantUser.findFirst({
      where: {id, tenantId},
      omit: {passwordHash: true},
    });
    if(!user) {
      throw new NotFoundException(`Tenant user ${id} not found`)
    }
    return user;
  }

  async update(tenantId: string ,id: string, dto: UpdateTenantUserDto) {
    await this.findOne(tenantId, id);

    const data: Prisma.TenantUserUpdateInput = {};
    if (dto.email) data.email = dto.email;
    if (dto.role) data.role = dto.role;
    if (dto.password) data.passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    return this.prisma.tenantUser.update({
      where: {id},
      data, omit: {passwordHash: true},
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(tenantId, id);
    return this.prisma.tenantUser.delete({
      where: {id},
      omit: {passwordHash: true}
    });
  }
}
