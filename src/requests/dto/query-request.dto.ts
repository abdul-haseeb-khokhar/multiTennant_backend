import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { MAX_SEARCH_LENGTH } from '../requests.constants';
import { REQUEST_STATUSES, REQUEST_TYPES } from '../state-machine';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class QueryRequestDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: REQUEST_STATUSES })
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  status?: string;

  @ApiPropertyOptional({ enum: REQUEST_TYPES })
  @IsOptional()
  @IsIn(REQUEST_TYPES)
  type?: string;

  @ApiPropertyOptional({
    description:
      "Only requests taken by this agent (the tenant's agent, not a staff member).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  agentId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Only requests saved at or after this moment (ISO-8601).',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Only requests saved at or before this moment (ISO-8601).',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    maxLength: MAX_SEARCH_LENGTH,
    description:
      "Part of the reference (AP-4K7Q2), of the customer's name or of their phone number.",
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  q?: string;
}

/** Only the filters that decide which requests are counted. */
export class QueryRequestCountsDto {
  @ApiPropertyOptional({
    description: 'Count only the requests of this agent.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  agentId?: string;
}
