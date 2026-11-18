import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { ListSalesDto } from './dto/list-sales.dto';
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

@Controller('pharmacy/sales')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Get()
  @RequirePermission('sale:read')
  findAll(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: ListSalesDto,
  ) {
    return this.salesService.findAll(actor.organizationId, branchIds, query);
  }

  @Get(':id')
  @RequirePermission('sale:read')
  findOne(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    return this.salesService.findOne(actor.organizationId, branchIds, id);
  }

  @Post()
  @RequirePermission('sale:record')
  async create(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: CreateSaleDto,
  ) {
    // A sale belongs to the branch that physically handed over the medicine.
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    return this.salesService.create(actor.organizationId, branchId, actor.userId, dto);
  }

  @Post(':id/void')
  @RequirePermission('sale:void')
  void(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    return this.salesService.void(actor.organizationId, branchIds, actor.userId, id);
  }

  @Post(':id/returns')
  @RequirePermission('sale:return')
  recordReturn(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
    @Body() dto: CreateSaleReturnDto,
  ) {
    return this.salesService.recordReturn(
      actor.organizationId,
      branchIds,
      actor.userId,
      id,
      dto,
    );
  }
}
