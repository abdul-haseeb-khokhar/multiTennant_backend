import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlanPage } from '../entities/billing.entities';
import { PlansService } from './plans.service';

@ApiTags('billing')
@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  @ApiOperation({
    summary: 'Public price list (pricing page)',
    description:
      'No authentication. Only public, active plans (Free, Pro, Enterprise today): the hidden Starter plan is never listed. Amounts are integer minor units of `currency`; `priceMinor: null` means "custom quote".',
  })
  @ApiOkResponse({ type: PlanPage })
  findPublic() {
    return this.plansService.findPublic();
  }
}
