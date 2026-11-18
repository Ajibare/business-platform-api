import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { ListStockDto } from './dto/list-stock.dto';
import { CurrentActor } from '../../../../common/decorators/current-actor.decorator';
import { CurrentBranch } from '../../../../common/decorators/current-branch.decorator';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../../common/guards/permissions.guard';
import { BranchScopeGuard } from '../../../../common/guards/branch-scope.guard';
import type { RequestActor } from '../../../platform/branches/branch-access.service';

@Controller('pharmacy/inventory')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class StockAvailabilityController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * Sellable quantity per medicine in the branches the caller can reach. Used
   * by the sales screen to show what can actually be sold right now.
   */
  @Get('stock')
  @RequirePermission('inventory:read')
  findStock(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: ListStockDto,
  ) {
    return this.inventoryService.stockOnHand(actor.organizationId, branchIds, query);
  }
}
