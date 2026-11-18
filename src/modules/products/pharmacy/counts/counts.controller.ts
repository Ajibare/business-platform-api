import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { CountsService } from './counts.service';
import { CreateCountDto } from './dto/create-count.dto';
import { AddCountLineDto } from './dto/add-count-line.dto';
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

@Controller('pharmacy/counts')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class CountsController {
  constructor(
    private readonly countsService: CountsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Post()
  @RequirePermission('inventory:count')
  async create(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: CreateCountDto,
  ) {
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    const count = await this.countsService.create(actor.organizationId, branchId, actor.userId, dto);
    return { data: count };
  }

  @Post(':id/lines')
  @RequirePermission('inventory:count')
  async addLine(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
    @Body() dto: AddCountLineDto,
  ) {
    const line = await this.countsService.addLine(actor.organizationId, branchIds, id, dto);
    return { data: line };
  }

  @Post(':id/submit')
  @RequirePermission('inventory:count')
  async submit(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    const count = await this.countsService.submit(actor.organizationId, branchIds, id);
    return { data: count };
  }

  /** Approving a count writes a stock adjustment, so it needs its own permission. */
  @Post(':id/approve')
  @RequirePermission('inventory:count', 'inventory:adjust')
  async approve(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    const count = await this.countsService.approve(
      actor.organizationId,
      branchIds,
      id,
      actor.userId,
    );
    return { data: count };
  }
}
