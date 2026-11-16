import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { ListStockDto } from './dto/list-stock.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';

@Controller('pharmacy/inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StockAvailabilityController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * Sellable quantity per medicine. Used by the sales screen so staff can see
   * what can actually be sold before recording a sale.
   */
  @Get('stock')
  findStock(
    @CurrentUser('organisationId') organizationId: string,
    @Query() query: ListStockDto,
  ) {
    return this.inventoryService.stockOnHand(organizationId, query);
  }
}
