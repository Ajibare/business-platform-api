import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { StockAvailabilityController } from './stock-availability.controller';
import { InventoryService } from './inventory.service';

@Module({
  controllers: [InventoryController, StockAvailabilityController],
  providers: [InventoryService],
})
export class InventoryModule {}
