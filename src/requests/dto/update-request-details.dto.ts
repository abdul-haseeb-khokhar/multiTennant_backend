import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { MAX_SUMMARY_LENGTH } from '../requests.constants';

/**
 * The engine corrects the details of a saved request (the caller changed their mind or answered an
 * optional question). Only while the request is `requested` (else 409 REQUEST_LOCKED). `data`
 * replaces the stored document, like the engine's own update.
 */
export class UpdateRequestDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUMMARY_LENGTH)
  summary?: string;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scheduledLocal?: string | null;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

/** The caller withdraws a request ("forget it"). */
export class WithdrawRequestDto {
  /** A short tag for the staff screen, not the caller's words. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
