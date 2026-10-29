import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_NOTE_LENGTH } from '../requests.constants';
import { REQUEST_STATUSES } from '../state-machine';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ChangeRequestStatusDto {
  @ApiProperty({
    enum: REQUEST_STATUSES,
    description:
      'The status to move to. Confirm = `confirmed`, mark done = `done`, cancel = `cancelled`, reopen = `requested` (from `confirmed` or `cancelled`) or `confirmed` (from `done`). The moves a request may make now are in its `allowedStatuses`.',
  })
  @IsIn(REQUEST_STATUSES)
  status: string;

  @ApiPropertyOptional({
    maxLength: MAX_NOTE_LENGTH,
    description:
      'A short note for the colleagues; it replaces the previous note. Personal data: it is not copied into the audit log.',
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_NOTE_LENGTH)
  note?: string;

  @ApiPropertyOptional({
    enum: REQUEST_STATUSES,
    description:
      'The status the screen showed. When the request is somewhere else by now, the answer is 409 REQUEST_STATUS_CONFLICT with the current status and nothing changes.',
  })
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  expectedStatus?: string;
}
