import { ApiProperty } from '@nestjs/swagger';

/** Response shape of a tenant (documentation only; Prisma rows are returned as they are). */
export class Tenant {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'acme' })
  slug: string;

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  plan: string;

  @ApiProperty({ enum: ['trial', 'active', 'suspended'] })
  status: string;

  @ApiProperty({ example: 'en', description: 'Default language (H7)' })
  defaultLocale: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
