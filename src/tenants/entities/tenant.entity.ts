import { ApiProperty } from '@nestjs/swagger';

/** Response shape of a tenant (documentation only; Prisma rows are returned as they are). */
export class Tenant {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'acme' })
  slug: string;

  @ApiProperty({
    enum: ['starter', 'free', 'pro', 'enterprise'],
    description:
      'Denormalised mirror of the subscription plan. The source of truth is GET /admin/tenants/:id/subscription.',
  })
  plan: string;

  @ApiProperty({
    enum: ['trial', 'active', 'suspended', 'closed'],
    description:
      'Denormalised mirror of the subscription state (trial = on Starter). The source of truth is GET /admin/tenants/:id/subscription.',
  })
  status: string;

  @ApiProperty({ example: 'en', description: 'Default language (H7)' })
  defaultLocale: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
