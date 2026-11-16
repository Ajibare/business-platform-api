import { Module } from '@nestjs/common';
import { AuditModule } from '../../../platform/audit/audit.module';
import { BarcodesModule } from '../barcodes/barcodes.module';
import { MedicinesController } from './medicines.controller';
import { MedicinesService } from './medicines.service';
import { BulkMedicinesService } from './bulk-medicines.service';

@Module({
  imports: [AuditModule, BarcodesModule],
  controllers: [MedicinesController],
  providers: [MedicinesService, BulkMedicinesService],
})
export class MedicinesModule {}
