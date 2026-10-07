import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';

export class QueryAuditLogDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Id of the acting user' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actor?: string;

  @ApiPropertyOptional({ example: 'user.role_changed' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Entries at or after this instant (ISO-8601)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Entries at or before this instant (ISO-8601)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
