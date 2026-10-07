import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { DEFAULT_TAKE, MAX_TAKE } from './pagination';

/** `skip` / `take` for every list endpoint (G1). Extend it for per-feature filters. */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_TAKE,
    default: DEFAULT_TAKE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TAKE)
  take?: number;
}
