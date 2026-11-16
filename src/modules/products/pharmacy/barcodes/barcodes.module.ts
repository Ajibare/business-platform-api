import { Module } from '@nestjs/common';
import { AuditModule } from '../../../platform/audit/audit.module';
import { BarcodesController } from './barcodes.controller';
import { BarcodesService } from './barcodes.service';

@Module({
  imports: [AuditModule],
  controllers: [BarcodesController],
  providers: [BarcodesService],
  exports: [BarcodesService],
})
export class BarcodesModule {}
