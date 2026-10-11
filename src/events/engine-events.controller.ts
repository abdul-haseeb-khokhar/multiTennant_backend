import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { EngineEventDto } from './dto/engine-event.dto';
import { EngineEventsAuthGuard } from './engine-events-auth.guard';
import { EngineEventsService } from './engine-events.service';

/**
 * `POST /internal/events`: where the AI engine pushes what happened (D5). Service to service, so it
 * lives OUTSIDE `/v1` (see `configureApp`), is not in the public OpenAPI document and must only be
 * reachable on the private network. The contract is docs/contracts/backend-events.openapi.yaml.
 */
@ApiExcludeController()
@Controller('internal/events')
export class EngineEventsController {
  constructor(private readonly events: EngineEventsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(EngineEventsAuthGuard)
  receive(@Body() dto: EngineEventDto) {
    return this.events.ingest(dto);
  }
}
