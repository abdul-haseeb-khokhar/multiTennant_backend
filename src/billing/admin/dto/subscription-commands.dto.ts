import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  CURRENCIES,
  MAX_AMOUNT_MINOR,
  PAYMENT_METHODS,
} from '../../billing.constants';

const PERIOD_INTERVALS = ['month', 'year'] as const;

class IdempotentCommandDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Optional client-chosen key. Sending the same key again for this tenant changes nothing (`duplicate: true`), so a retry or a double click cannot record a payment twice.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}

class PaymentDto extends IdempotentCommandDto {
  @ApiPropertyOptional({
    enum: PERIOD_INTERVALS,
    description:
      'Length of the paid period. Defaults to the plan interval (or the current one for a renewal). Ignored when `periodEnd` is given.',
  })
  @IsOptional()
  @IsIn(PERIOD_INTERVALS)
  interval?: 'month' | 'year';

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'End of the paid period (ISO-8601). Required for plans without a billing interval, such as Enterprise.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  periodEnd?: Date;

  @ApiProperty({
    example: 1999900,
    description:
      'Amount received, integer minor units (PKR 19,999.00 = 1999900).',
    minimum: 1,
    maximum: MAX_AMOUNT_MINOR,
  })
  // No string-to-number coercion: money must arrive as a JSON integer.
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_MINOR)
  amountMinor: number;

  @ApiProperty({ enum: CURRENCIES, example: 'PKR' })
  @IsIn(CURRENCIES)
  currency: string;

  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Bank transaction id, cheque number, receipt number...',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class ActivateSubscriptionDto extends PaymentDto {
  @ApiProperty({
    example: 'pro',
    description: 'A paid plan: pro or enterprise.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  planCode: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Per-tenant entitlements merged over the plan (custom Enterprise contracts), for example `{ "seats": 40, "voice": true }`.',
  })
  @IsOptional()
  @IsObject()
  entitlementsOverride?: Record<string, unknown>;
}

export class RecordPaymentDto extends PaymentDto {}

export class ExtendSubscriptionDto extends IdempotentCommandDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'New end of the current period. Send this or `days`.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  until?: Date;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 366,
    description: 'Days to add to the current end. Send this or `until`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  days?: number;
}

export class ChangePlanDto extends IdempotentCommandDto {
  @ApiProperty({ example: 'free' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  planCode: string;

  @ApiPropertyOptional({ enum: PERIOD_INTERVALS })
  @IsOptional()
  @IsIn(PERIOD_INTERVALS)
  interval?: 'month' | 'year';

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'End of the period when moving to a paid plan without a payment (a comped period). Without it, a running paid period is kept, else one interval is granted.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  periodEnd?: Date;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  entitlementsOverride?: Record<string, unknown>;
}

export class CancelSubscriptionDto extends IdempotentCommandDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'true (default): keep the plan until the period ends, then fall back to Free. false: fall back to Free now.',
  })
  @IsOptional()
  @IsBoolean()
  atPeriodEnd?: boolean;
}
