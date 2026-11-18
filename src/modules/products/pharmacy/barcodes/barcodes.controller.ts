import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { BarcodesService } from './barcodes.service';
import { LookupBarcodeDto } from './dto/lookup-barcode.dto';
import { UpdateBarcodeDto } from './dto/update-barcode.dto';
import { CurrentActor } from '../../../../common/decorators/current-actor.decorator';
import { CurrentBranch } from '../../../../common/decorators/current-branch.decorator';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../../common/guards/permissions.guard';
import { BranchScopeGuard } from '../../../../common/guards/branch-scope.guard';
import type { RequestActor } from '../../../platform/branches/branch-access.service';

@Controller('pharmacy/barcodes')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class BarcodesController {
  constructor(private readonly barcodesService: BarcodesService) {}

  @Get('lookup')
  @RequirePermission('product:read')
  async lookup(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: LookupBarcodeDto,
  ) {
    const result = await this.barcodesService.lookup(actor.organizationId, branchIds, query.code);
    return { data: result };
  }

  @Put('product/:productId')
  @RequirePermission('product:manage')
  assign(
    @CurrentActor() actor: RequestActor,
    @Param('productId') productId: string,
    @Body() dto: UpdateBarcodeDto,
  ) {
    return this.barcodesService.assign(actor.organizationId, actor.userId, productId, dto.barcode);
  }
}
