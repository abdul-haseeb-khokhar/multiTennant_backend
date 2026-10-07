import { PartialType } from '@nestjs/swagger';
import { CreateEndCustomerDto } from './create-end-customer.dto';

export class UpdateEndCustomerDto extends PartialType(CreateEndCustomerDto) {}
