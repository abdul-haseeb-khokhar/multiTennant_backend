import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] })
  plan: string;

  @ApiProperty({ enum: ['trial', 'active', 'suspended'] })
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
    example: 'ur',
    description:
      "The language to render the dashboard in: the user's own, else the tenant default",
  })
  locale: string;
}
