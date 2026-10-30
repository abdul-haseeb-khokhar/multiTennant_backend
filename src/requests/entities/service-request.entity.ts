import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { REQUEST_STATUSES, REQUEST_TYPES } from '../state-machine';

/** The agent (the tenant's own setup, not a staff member) that took the call. */
export class RequestAgent {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Evening reception' })
  name: string;
}

/** The caller as staff see them. The phone number is shown whole to every role. */
export class RequestCustomer {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  name: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+923001234567',
    description: 'E.164; null when the customer did not reach us by telephone.',
  })
  phone: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ur' })
  locale: string | null;
}

/**
 * A request the AI took on a call (an appointment or a call-back) that staff confirm. The AI never
 * books or confirms anything (L1): it saves the request as `requested` and a person moves it on.
 */
export class ServiceRequest {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'AP-4K7Q2',
    description: 'What the caller was told; unique within the workspace.',
  })
  reference: string;

  @ApiProperty({ enum: REQUEST_TYPES })
  type: string;

  @ApiProperty({ enum: REQUEST_STATUSES })
  status: string;

  @ApiProperty({
    enum: REQUEST_STATUSES,
    isArray: true,
    description:
      'The statuses a person may move this request to now (the workflow, so the screen needs no copy of it).',
  })
  allowedStatuses: string[];

  @ApiProperty({ type: RequestAgent })
  agent: RequestAgent;

  @ApiPropertyOptional({ type: RequestCustomer, nullable: true })
  customer: RequestCustomer | null;

  @ApiProperty({ enum: ['voice', 'chat'] })
  channel: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ur' })
  language: string | null;

  @ApiProperty({ description: 'One or two lines written by the AI.' })
  summary: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-11-03 15:30',
    description:
      "The business's wall-clock time as text, on purpose: read it in `timezone`.",
  })
  scheduledLocal: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Asia/Karachi',
  })
  timezone: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'The version of the agent settings the call was served with.',
  })
  configVersion: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "The engine's id of the call.",
  })
  conversationId: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'What the agent collected (name, service, notes ...). The engine owns the field list; show what is there. Personal data: only in the detail view, not in the list.',
  })
  details?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The latest note a colleague left with a status change.',
  })
  note: string | null;

  @ApiPropertyOptional({
    enum: ['caller', 'staff'],
    nullable: true,
    description:
      'Who cancelled it: the caller (withdrew it on the phone) or a person on the staff screen.',
  })
  cancelledBy: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  statusChangedAt: Date | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The staff member who made the last status change; null when no person did.',
  })
  statusChangedBy: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class RequestCounts {
  @ApiProperty()
  requested: number;

  @ApiProperty()
  confirmed: number;

  @ApiProperty()
  done: number;

  @ApiProperty()
  cancelled: number;

  @ApiProperty({ description: 'All requests, whatever their status.' })
  total: number;
}
