import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { AGENT_STATUSES } from './update-agent.dto';

export class QueryAgentDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: AGENT_STATUSES,
    description: 'Only agents with this status.',
  })
  @IsOptional()
  @IsIn(AGENT_STATUSES)
  status?: string;
}
