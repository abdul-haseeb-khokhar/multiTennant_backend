import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateWidgetSessionDto {
  @ApiProperty({
    example: 'wk_AbCd1234…',
    description:
      "The tenant's public widget key (from the dashboard). It is an identifier, not a secret: it only works from the origins listed for it.",
  })
  @IsString()
  @MaxLength(100)
  widgetKey: string;

  @ApiProperty({
    example: '3f9c1b7e-52aa-4d0e-9a41-6f1d2b8c7e10',
    description:
      "A random id the widget creates once (crypto.randomUUID()) and keeps in localStorage. 16 to 64 characters of A-Z a-z 0-9 _ -. Whoever knows it can resume that visitor's chat, so it must be unguessable and is never shown or logged.",
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,64}$/, {
    message: 'visitorId must be 16 to 64 characters of A-Z, a-z, 0-9, _ or -',
  })
  visitorId: string;

  @ApiPropertyOptional({
    example: 'ur',
    description:
      "The visitor's language (the browser's, e.g. `ur-PK`). Falls back to the tenant default, then `en`.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/, {
    message: 'locale must look like en or ur-PK',
  })
  locale?: string;
}
