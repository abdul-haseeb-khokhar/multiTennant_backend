import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthUser } from '../auth/roles';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantUserDto } from './dto/create-tenant-user.dto';
import { QueryTenantUserDto } from './dto/query-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';

const SALT_ROUNDS = 10;

/**
 * Every method takes `tenantId` first and puts it in each query's `where`. `actor` is the staff
 * member making the change; it drives the owner rules from the role matrix (B2): only an owner
 * may create an owner, change an owner or promote someone to owner, and a tenant never loses
 * its last owner.
 */
@Injectable()
export class TenantUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateTenantUserDto, actor: AuthUser) {
    if (dto.role === 'owner') {
      this.requireOwner(actor);
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    try {
      return await this.prisma.tenantUser.create({
        data: { tenantId, email: dto.email, passwordHash, role: dto.role },
        omit: { passwordHash: true },
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
        throw this.emailTaken();
      }
      throw error;
    }
  }

  async findAll(tenantId: string, query: QueryTenantUserDto) {
    const page = resolvePage(query);
    const [data, total] = await Promise.all([
      this.prisma.tenantUser.findMany({
        where: { tenantId },
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        omit: { passwordHash: true },
      }),
      this.prisma.tenantUser.count({ where: { tenantId } }),
    ]);
    return toPage(data, total, page);
  }

  async findOne(tenantId: string, id: string) {
    const user = await this.prisma.tenantUser.findFirst({
      where: { id, tenantId },
      omit: { passwordHash: true },
    });
    if (!user) {
      throw this.notFound(id);
    }
    return user;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateTenantUserDto,
    actor: AuthUser,
  ) {
    const existing = await this.findOne(tenantId, id);

    if (existing.role === 'owner' || dto.role === 'owner') {
      this.requireOwner(actor);
    }
    if (existing.role === 'owner' && dto.role && dto.role !== 'owner') {
      await this.assertNotLastOwner(tenantId);
    }

    const data: Prisma.TenantUserUpdateInput = {};
    if (dto.email) data.email = dto.email;
    if (dto.role) data.role = dto.role;
    if (dto.password) {
      data.passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    }

    try {
      return await this.prisma.tenantUser.update({
        where: { id, tenantId },
        data,
        omit: { passwordHash: true },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw this.emailTaken();
      }
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  async remove(tenantId: string, id: string, actor: AuthUser) {
    const existing = await this.findOne(tenantId, id);

    if (existing.role === 'owner') {
      this.requireOwner(actor);
      await this.assertNotLastOwner(tenantId);
    }

    try {
      return await this.prisma.tenantUser.delete({
        where: { id, tenantId },
        omit: { passwordHash: true },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw this.notFound(id);
      }
      throw error;
    }
  }

  private requireOwner(actor: AuthUser) {
    if (actor.role !== 'owner') {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.OWNER_REQUIRED,
        'Only an owner can create, change or remove an owner',
      );
    }
  }

  private async assertNotLastOwner(tenantId: string) {
    const owners = await this.prisma.tenantUser.count({
      where: { tenantId, role: 'owner' },
    });
    if (owners <= 1) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.LAST_OWNER,
        'A tenant must keep at least one owner',
      );
    }
  }

  private notFound(id: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.USER_NOT_FOUND,
      `Tenant user ${id} not found`,
    );
  }

  private emailTaken() {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.EMAIL_TAKEN,
      'A user with this email already exists for this tenant',
    );
  }
}
