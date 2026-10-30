import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

export const UPGRADE_REQUEST_STATUSES = [
  'pending',
  'handled',
  'declined',
] as const;
export type UpgradeRequestStatus = (typeof UPGRADE_REQUEST_STATUSES)[number];

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateUpgradeRequestDto {
  @ApiProperty({
    example: 'pro',
    description:
      'The plan the owner wants. Must be a public plan from GET /v1/plans and different from the current one.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  planCode: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Anything the platform team should know (seen by them only).',
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class HandleUpgradeRequestDto {
  @ApiProperty({
    enum: ['handled', 'declined'],
    description:
      '`handled`: the platform admin took care of it (normally by activating the plan through the subscription routes). `declined`: no.',
  })
  @IsIn(['handled', 'declined'])
  status: 'handled' | 'declined';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class QueryUpgradeRequestsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: UPGRADE_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(UPGRADE_REQUEST_STATUSES)
  status?: UpgradeRequestStatus;
}
