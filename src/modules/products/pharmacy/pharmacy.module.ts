import { Module } from '@nestjs/common';
import { BarcodesModule } from './barcodes/barcodes.module';
import { BatchesModule } from './batches/batches.module';
import { CountsModule } from './counts/counts.module';
import { ExpiryModule } from './expiry/expiry.module';
import { ImportsModule } from './imports/imports.module';
import { InventoryModule } from './inventory/inventory.module';
import { MedicinesModule } from './medicines/medicines.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { ReportsModule } from './reports/reports.module';
import { SalesModule } from './sales/sales.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { TransfersModule } from './transfers/transfers.module';

@Module({
  imports: [
    BarcodesModule,
    BatchesModule,
    CountsModule,
    ExpiryModule,
    ImportsModule,
    InventoryModule,
    MedicinesModule,
    ReceiptsModule,
    ReportsModule,
    SalesModule,
    SuppliersModule,
    TransfersModule,
  ],
})
export class PharmacyModule {}
