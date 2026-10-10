import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { QueryApiKeyDto } from './dto/query-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import { ApiKeyView, CreatedApiKey } from './entities/api-key.entity';

@ApiTags('api-keys')
@ApiBearerAuth()
@Controller('tenants/:tenantId/api-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Create a widget or server API key (owner/admin)',
    description:
      'The response carries the full `key` ONCE; only its hash is stored, so it cannot be shown again. A widget key is public by nature (it sits in your page): it only works from the origins in `allowedOrigins`. Creating a widget key needs chat in the plan (403 PLAN_FEATURE_UNAVAILABLE) and an account in good standing. At most 10 active keys per tenant (409 API_KEY_LIMIT_REACHED).',
  })
  @ApiCreatedResponse({ type: CreatedApiKey })
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.apiKeys.create(tenantId, dto, actor);
  }

  @Get()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'List API keys (owner/admin)',
    description:
      'Prefix, origins and last use; never the key or its hash. Revoked keys are hidden unless `includeRevoked=true`. Agents get 403: key prefixes and origins are not needed to answer customers.',
  })
  @ApiPaginatedResponse(ApiKeyView)
  findAll(@Param('tenantId') tenantId: string, @Query() query: QueryApiKeyDto) {
    return this.apiKeys.findAll(tenantId, query);
  }

  @Get(':id')
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'One API key (owner/admin)' })
  @ApiOkResponse({ type: ApiKeyView })
  findOne(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.apiKeys.findOne(tenantId, id);
  }

  @Patch(':id')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Rename a key or replace its allowed origins (owner/admin)',
    description:
      'Takes effect on the next widget request (widget tokens are re-checked against the key). A revoked key cannot be changed (409).',
  })
  @ApiOkResponse({ type: ApiKeyView })
  update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.apiKeys.update(tenantId, id, dto, actor);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Revoke an API key (owner/admin)',
    description:
      'Permanent and idempotent. Sessions started with the key stop working at their next request, and new sessions are refused (401 WIDGET_KEY_INVALID).',
  })
  @ApiOkResponse({ type: ApiKeyView })
  revoke(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.apiKeys.revoke(tenantId, id, actor);
  }
}
