import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AGENT_NAME_MAX } from '../agent-settings.defaults';

/** A new agent starts with the default settings (the tenant's business name, time zone and language, Monday to Friday 09:00 to 17:00, call forwarding off). */
export class CreateAgentDto {
  @ApiProperty({
    example: 'Evening reception',
    minLength: 1,
    maxLength: AGENT_NAME_MAX,
    description:
      'The label of the agent inside the dashboard. Unique within the workspace, ignoring case (409 AGENT_NAME_TAKEN).',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_NAME_MAX)
  name: string;
}
