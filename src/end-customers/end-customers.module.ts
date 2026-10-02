import { Module } from '@nestjs/common';
import { EndCustomersService } from './end-customers.service';
import { EndCustomersController } from './end-customers.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [EndCustomersController],
  providers: [EndCustomersService],
})
export class EndCustomersModule {}
