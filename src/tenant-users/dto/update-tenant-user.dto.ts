import { PartialType } from '@nestjs/swagger';
import { CreateTenantUserDto } from './create-tenant-user.dto';

export class UpdateTenantUserDto extends PartialType(CreateTenantUserDto) {}
