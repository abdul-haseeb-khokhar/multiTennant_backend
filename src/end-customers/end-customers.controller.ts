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
  ApiNotFoundResponse,
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
import { ConversationsService } from '../conversations/conversations.service';
import { QueryConversationDto } from '../conversations/dto/conversation.dto';
import { Conversation } from '../conversations/entities/conversation.entity';
import { CreateEndCustomerDto } from './dto/create-end-customer.dto';
import { QueryEndCustomerDto } from './dto/query-end-customer.dto';
import { UpdateEndCustomerDto } from './dto/update-end-customer.dto';
import { EndCustomersService } from './end-customers.service';
import { EndCustomer } from './entities/end-customer.entity';

@ApiTags('customers')
@ApiBearerAuth()
@Controller('tenants/:tenantId/customers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EndCustomersController {
  constructor(
    private readonly endCustomersService: EndCustomersService,
    private readonly conversations: ConversationsService,
  ) {}

  @Post()
  @Roles('owner', 'admin', 'agent')
  @ApiCreatedResponse({ type: EndCustomer })
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateEndCustomerDto,
  ) {
    return this.endCustomersService.create(tenantId, dto);
  }

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiPaginatedResponse(EndCustomer)
  findAll(
    @Param('tenantId') tenantId: string,
    @Query() query: QueryEndCustomerDto,
  ) {
    return this.endCustomersService.findAll(tenantId, query);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'agent')
  @ApiOkResponse({ type: EndCustomer })
  findOne(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.endCustomersService.findOne(tenantId, id);
  }

  @Get(':id/conversations')
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'Conversations of one customer (every role)',
    description:
      'The customer view: the same list as `GET …/conversations?customerId=`, newest activity first. A customer of another tenant is a 404 CUSTOMER_NOT_FOUND.',
  })
  @ApiPaginatedResponse(Conversation)
  @ApiNotFoundResponse({ description: 'CUSTOMER_NOT_FOUND' })
  conversationsOf(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() query: QueryConversationDto,
  ) {
    return this.conversations.listForCustomer(user, id, query);
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'agent')
  @ApiOkResponse({ type: EndCustomer })
  update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEndCustomerDto,
  ) {
    return this.endCustomersService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  @ApiOkResponse({ type: EndCustomer })
  remove(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.endCustomersService.remove(tenantId, id);
  }
}
