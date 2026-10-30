import { ApiProperty } from '@nestjs/swagger';

class PreviousSlug {
  @ApiProperty({ example: 'acme' })
  slug: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Until then the old slug still logs in.',
  })
  acceptedUntil: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Until then nobody else can take the old slug.',
  })
  reservedUntil: Date;
}

/** The workspace as its own staff see and (owner only) edit it: `GET`/`PATCH /v1/tenants/:tenantId`. */
export class TenantSettings {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'acme' })
  slug: string;

  @ApiProperty({ example: 'en', description: 'Default language (H7)' })
  defaultLocale: string;

  @ApiProperty({
    example: 'Asia/Karachi',
    description: 'IANA time zone name (J7).',
  })
  timezone: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the slug was last renamed; null if never.',
  })
  slugChangedAt: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the slug may be renamed again; null when a rename is possible now.',
  })
  slugChangeAllowedAt: Date | null;

  @ApiProperty({
    type: [PreviousSlug],
    description:
      'Slugs this workspace used to have that are still reserved (90 days), newest first.',
  })
  previousSlugs: PreviousSlug[];
}
