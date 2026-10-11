import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateBillingSettingsDto {
  @ApiProperty({
    description:
      'true (the default): past the included conversations the AI keeps answering and each extra conversation is billed at the plan price. false: a hard stop, the customer gets the fallback and the conversation goes to a human. Only plans with an overage price (Pro) have this setting; others answer 409 OVERAGE_NOT_AVAILABLE.',
  })
  @IsBoolean()
  overageEnabled: boolean;
}
