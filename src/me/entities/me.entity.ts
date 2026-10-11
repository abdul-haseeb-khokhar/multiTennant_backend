import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SubscriptionSummary } from '../../billing/entities/billing.entities';

class MeUser {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'agent@acme.com' })
  email: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  name: string | null;

  @ApiProperty({ enum: ['owner', 'admin', 'agent'] })
  role: string;

  @ApiProperty({ description: 'False until the emailed link is used (H4)' })
  emailVerified: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The language the user chose, if any',
  })
  locale: string | null;
}

class MeTenant {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'acme' })
  slug: string;

  @ApiProperty({
    enum: ['starter', 'free', 'pro', 'enterprise'],
    description: 'Mirror of the subscription plan; prefer `subscription`.',
  })
  plan: string;

  @ApiProperty({
    enum: ['trial', 'active', 'suspended', 'closed'],
    description: 'Mirror of the subscription state; prefer `subscription`.',
  })
  status: string;

  @ApiProperty({ example: 'en' })
  defaultLocale: string;
}

export class Me {
  @ApiProperty({ type: MeUser })
  user: MeUser;

  @ApiProperty({ type: MeTenant })
  tenant: MeTenant;

  @ApiProperty({
    type: SubscriptionSummary,
    nullable: true,
    description:
      'Plan, status, period end, days left and limits, for the dashboard banner.',
  })
  subscription: SubscriptionSummary | null;

  @ApiProperty({
    example: 3,
    description:
      'How many of my in-app notifications are unread (the bell badge). The list is GET /v1/tenants/:tenantId/notifications.',
  })
  unreadNotifications: number;

  @ApiProperty({
    example: 'ur',
    description:
      "The language to render the dashboard in: the user's own, else the tenant default",
  })
  locale: string;
}
