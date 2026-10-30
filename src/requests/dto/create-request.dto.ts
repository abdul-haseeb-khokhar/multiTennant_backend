import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  MAX_SUBMISSION_KEY_LENGTH,
  MAX_SUMMARY_LENGTH,
  REFERENCE_PATTERN,
  REQUEST_CHANNELS,
} from '../requests.constants';
import { REQUEST_TYPES } from '../state-machine';

const upperTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * What the engine sends to save a request it took on a call (his B4; the draft contract is
 * `docs/contracts/backend-internal.openapi.yaml`). Internal route: not in the public OpenAPI.
 */
export class CreateRequestDto {
  /** The agent that took the call; default the tenant's default agent. One of another tenant answers 404 AGENT_NOT_FOUND. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  agentId?: string;

  /** Drawn by the engine, unique per tenant (409 REQUEST_REFERENCE_TAKEN: draw another). Stored upper case. */
  @Transform(upperTrim)
  @IsString()
  @Matches(REFERENCE_PATTERN, {
    message:
      'reference must be 3 to 40 letters, digits or hyphens, for example AP-4K7Q2',
  })
  reference: string;

  @IsIn(REQUEST_TYPES)
  type: string;

  /** Makes saving idempotent: the same key in the same tenant is the same request. */
  @IsString()
  @Length(1, MAX_SUBMISSION_KEY_LENGTH)
  submissionKey: string;

  /** From the customer upsert. Must be a customer of this tenant (404 CUSTOMER_NOT_FOUND). */
  @IsString()
  @Length(1, 100)
  endCustomerId: string;

  /** The engine's id of the call. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  conversationId?: string;

  @IsOptional()
  @IsIn(REQUEST_CHANNELS)
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @IsString()
  @MaxLength(MAX_SUMMARY_LENGTH)
  summary: string;

  /** The business's wall-clock time as a string, on purpose. */
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scheduledLocal?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  /** The version of the agent settings the engine used for the call. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  configVersion?: number;

  /** What the agent collected; the engine owns the field list, the backend stores it as is (16 KB at most). */
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
