import { Type } from 'class-transformer';
import {
  IsDateString,
  IsDefined,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** The envelope the engine posts (docs/contracts/backend-events.openapi.yaml). */
export class EngineEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  id: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, {
    message: 'type must look like "conversation.escalated"',
  })
  @MaxLength(100)
  type: string;

  /** The only tenant the backend uses for this event. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  tenantId: string;

  @IsDateString()
  occurredAt: string;

  @IsDefined()
  @IsObject()
  @Type(() => Object)
  data: Record<string, unknown>;
}
