import { Module } from '@nestjs/common';
import { BatchesModule } from './batches/batches.module';
import { CountsModule } from './counts/counts.module';
import { ExpiryModule } from './expiry/expiry.module';
import { InventoryModule } from './inventory/inventory.module';
import { MedicinesModule } from './medicines/medicines.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { ReportsModule } from './reports/reports.module';
import { SuppliersModule } from './suppliers/suppliers.module';

@Module({
  imports: [
    BatchesModule,
    CountsModule,
    ExpiryModule,
    InventoryModule,
    MedicinesModule,
    ReceiptsModule,
    ReportsModule,
    SuppliersModule,
  ],
})
export class PharmacyModule {}
