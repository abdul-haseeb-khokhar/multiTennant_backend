import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateBillingSettingsDto {
  @ApiProperty({
    description:
      "true (the default): past the included call minutes (and chat conversations) the service keeps going and each extra minute (or conversation) is billed at the plan price. false: a hard stop; the engine's status check answers `quota_exceeded` and chat customers get the fallback. One switch for both. Only plans with an overage price (Pro) have this setting; others answer 409 OVERAGE_NOT_AVAILABLE.",
  })
  @IsBoolean()
  overageEnabled: boolean;
}
