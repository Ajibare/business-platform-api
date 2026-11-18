import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ExpiryService } from './expiry.service';
import { CurrentActor } from '../../../../common/decorators/current-actor.decorator';
import { CurrentBranch } from '../../../../common/decorators/current-branch.decorator';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../../common/guards/permissions.guard';
import { BranchScopeGuard } from '../../../../common/guards/branch-scope.guard';
import type { RequestActor } from '../../../platform/branches/branch-access.service';

@Controller('pharmacy/expiry')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class ExpiryController {
  constructor(private readonly expiryService: ExpiryService) {}

  @Get('alerts')
  @RequirePermission('expiry:read')
  async getAlerts(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query('days') days?: string,
    @Query('q') search?: string,
  ) {
    const parsed = days ? Number(days) : undefined;
    return this.expiryService.getAlerts(actor.organizationId, branchIds, {
      windowDays: parsed && Number.isFinite(parsed) ? parsed : undefined,
      search,
    });
  }

  @Get('near')
  @RequirePermission('expiry:read')
  async findNear(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query('days') days?: string,
  ) {
    const parsed = days ? Number(days) : 30;
    return this.expiryService.findNear(actor.organizationId, branchIds, parsed);
  }

  @Get('expired')
  @RequirePermission('expiry:read')
  async findExpired(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
  ) {
    return this.expiryService.findExpired(actor.organizationId, branchIds);
  }

  @Get('unknown')
  @RequirePermission('expiry:read')
  async findUnknown(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
  ) {
    return this.expiryService.findUnknown(actor.organizationId, branchIds);
  }
}
