import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ReceiptsService } from './receipts.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
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

@Controller('pharmacy/receipts')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class ReceiptsController {
  constructor(
    private readonly receiptsService: ReceiptsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Post()
  @RequirePermission('inventory:receive')
  async create(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: CreateReceiptDto,
  ) {
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    const receipt = await this.receiptsService.create(
      actor.organizationId,
      branchId,
      actor.userId,
      dto,
    );
    return { data: receipt };
  }

  @Post(':id/confirm')
  @RequirePermission('inventory:receive')
  async confirm(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    const receipt = await this.receiptsService.confirm(
      actor.organizationId,
      branchIds,
      id,
      actor.userId,
    );
    return { data: receipt };
  }
}
