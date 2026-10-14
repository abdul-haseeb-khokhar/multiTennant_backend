import { ApiProperty } from '@nestjs/swagger';

/** Response shapes (documentation only). */

export class UpgradeRequestView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'pro' })
  requestedPlanCode: string;

  @ApiProperty({ example: 'Pro' })
  requestedPlanName: string;

  @ApiProperty({ type: String, nullable: true })
  note: string | null;

  @ApiProperty({ enum: ['pending', 'handled', 'declined'] })
  status: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  handledAt: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the platform admin wrote when handling it.',
  })
  handledNote: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class UpgradeRequestCreated extends UpgradeRequestView {
  @ApiProperty({
    description:
      'True when the tenant already had a pending request and this one replaced its plan and note.',
  })
  replacedPending: boolean;

  @ApiProperty({
    enum: ['sent', 'failed', 'skipped', 'not_configured'],
    description:
      'What happened to the email to the platform admins. The request is stored whatever this says. `not_configured`: PLATFORM_ADMIN_NOTIFY_EMAIL is not set; `skipped`: the development console mailer is active.',
  })
  notification: string;
}

class UpgradeRequestTenant {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'acme' })
  slug: string;
}

export class AdminUpgradeRequestView extends UpgradeRequestView {
  @ApiProperty({ type: UpgradeRequestTenant })
  tenant: UpgradeRequestTenant;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'starter',
    description: "The tenant's plan now (from its subscription).",
  })
  currentPlanCode: string | null;

  @ApiProperty({ type: String, nullable: true })
  requestedByEmail: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The platform admin who handled it.',
  })
  handledBy: string | null;
}

export class LatestUpgradeRequest {
  @ApiProperty({
    type: UpgradeRequestView,
    nullable: true,
    description:
      'The latest request of this workspace in any status, or null if there never was one.',
  })
  request: UpgradeRequestView | null;
}
