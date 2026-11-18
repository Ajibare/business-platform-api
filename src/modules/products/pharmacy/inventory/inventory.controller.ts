import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { CreateMovementDto } from './dto/create-movement.dto';
import { ListMovementsDto } from './dto/list-movements.dto';
import { CurrentActor } from '../../../../common/decorators/current-actor.decorator';
import { CurrentBranch } from '../../../../common/decorators/current-branch.decorator';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../../common/guards/permissions.guard';
import { BranchScopeGuard } from '../../../../common/guards/branch-scope.guard';
import {
  BranchAccessService,
  type BranchScope,
  type RequestActor,
} from '../../../platform/branches/branch-access.service';

@Controller('pharmacy/movements')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Post()
  @RequirePermission('inventory:adjust')
  async create(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: CreateMovementDto,
  ) {
    // A movement changes stock, so it must belong to one active branch.
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    const movement = await this.inventoryService.create(
      actor.organizationId,
      branchId,
      actor.userId,
      dto,
    );
    return { data: movement };
  }

  @Get()
  @RequirePermission('inventory:read')
  findAll(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: ListMovementsDto,
  ) {
    return this.inventoryService.findAll(actor.organizationId, branchIds, query);
  }
}
