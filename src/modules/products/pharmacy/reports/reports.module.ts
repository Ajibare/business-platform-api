import { Module } from '@nestjs/common';
import { ExpiryModule } from '../expiry/expiry.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [ExpiryModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
