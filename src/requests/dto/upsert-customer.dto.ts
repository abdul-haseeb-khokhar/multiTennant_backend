import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { E164_PATTERN } from '../../end-customers/phone-customers.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Find or create the end customer for a caller's number (his B4, L4.3). The number travels in the body,
 * never in a URL (personal data, F1).
 */
export class UpsertCustomerByPhoneDto {
  /** The agent whose call this is (default the tenant's default agent). One of another tenant answers 404 AGENT_NOT_FOUND. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  agentId?: string;

  @Transform(trim)
  @IsString()
  @Matches(E164_PATTERN, {
    message: 'phone must be in international form, for example +923001234567',
  })
  phone: string;

  /** Only filled in when the customer has no name yet. */
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** Only filled in when the customer has no language yet. */
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}
