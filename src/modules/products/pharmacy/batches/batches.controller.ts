import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { ListBatchesDto } from './dto/list-batches.dto';
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

@Controller('pharmacy/batches')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class BatchesController {
  constructor(
    private readonly batchesService: BatchesService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Get()
  @RequirePermission('inventory:read')
  findAll(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: ListBatchesDto,
  ) {
    return this.batchesService.findAll(actor.organizationId, branchIds, query);
  }

  @Post()
  @RequirePermission('inventory:receive')
  async create(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: CreateBatchDto,
  ) {
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    const batch = await this.batchesService.create(
      actor.organizationId,
      branchId,
      actor.userId,
      dto,
    );
    return { data: batch };
  }

  @Get(':id')
  @RequirePermission('inventory:read')
  async findOne(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    const batch = await this.batchesService.findOne(actor.organizationId, branchIds, id);
    return { data: batch };
  }
}
