import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AGENT_NAME_MAX } from '../agent-settings.defaults';

export const AGENT_STATUSES = ['active', 'disabled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export class UpdateAgentDto {
  @ApiPropertyOptional({
    example: 'Night desk',
    minLength: 1,
    maxLength: AGENT_NAME_MAX,
    description:
      'Rename the agent (409 AGENT_NAME_TAKEN if another one has the name).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({
    enum: AGENT_STATUSES,
    description:
      '`disabled`: the engine plays the "not available" message for this agent; staff can still read and edit it. Refused (409 AGENT_HAS_NUMBERS) while the agent has phone numbers.',
  })
  @IsOptional()
  @IsIn(AGENT_STATUSES)
  status?: AgentStatus;
}
