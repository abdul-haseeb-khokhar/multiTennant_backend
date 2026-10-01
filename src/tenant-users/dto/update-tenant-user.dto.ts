import { PartialType } from '@nestjs/mapped-types';
import { CreateTenantUserDto } from './create-tenant-user.dto';

export class UpdateTenantUserDto extends PartialType(CreateTenantUserDto) {}
