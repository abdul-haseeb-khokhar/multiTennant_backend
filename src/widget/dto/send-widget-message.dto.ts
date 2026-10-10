import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendWidgetMessageDto {
  @ApiProperty({
    example: 'What are your opening hours?',
    maxLength: 2000,
    description:
      "The customer's text, at most 2,000 characters (longer: 400 MESSAGE_TOO_LONG). Surrounding whitespace is trimmed.",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  // A sanity bound on the payload; the real limit (and its own error code) is checked in the service.
  @MaxLength(50_000)
  content: string;
}
