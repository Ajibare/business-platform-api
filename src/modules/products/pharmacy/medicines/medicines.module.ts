import { Module } from '@nestjs/common';
import { BarcodesModule } from '../barcodes/barcodes.module';
import { MedicinesController } from './medicines.controller';
import { MedicinesService } from './medicines.service';
import { BulkMedicinesService } from './bulk-medicines.service';

@Module({
  imports: [BarcodesModule],
  controllers: [MedicinesController],
  providers: [MedicinesService, BulkMedicinesService],
})
export class MedicinesModule {}
