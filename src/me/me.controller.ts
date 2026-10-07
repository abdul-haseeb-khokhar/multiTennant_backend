import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateMeDto } from './dto/update-me.dto';
import { Me } from './entities/me.entity';
import { MeService } from './me.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary:
      'Who am I: profile, role, tenant (slug, plan, status) and language',
  })
  @ApiOkResponse({ type: Me })
  get(@CurrentUser() actor: AuthUser) {
    return this.meService.get(actor);
  }

  @Patch()
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({ summary: 'Change my own name or dashboard language' })
  @ApiOkResponse({ type: Me })
  update(@CurrentUser() actor: AuthUser, @Body() dto: UpdateMeDto) {
    return this.meService.update(actor, dto);
  }
}
