import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService, type TrendGranularity } from './reports.service';
import { CurrentActor } from '../../../../common/decorators/current-actor.decorator';
import { CurrentBranch } from '../../../../common/decorators/current-branch.decorator';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../../common/guards/permissions.guard';
import { BranchScopeGuard } from '../../../../common/guards/branch-scope.guard';
import type { RequestActor } from '../../../platform/branches/branch-access.service';

@Controller('pharmacy/reports')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('dashboard')
  @RequirePermission('report:read')
  async getDashboard(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query('warningDays') warningDays?: string,
  ) {
    const parsed = warningDays ? Number(warningDays) : 30;
    return this.reportsService.getDashboard(actor.organizationId, branchIds, parsed);
  }

  @Get('low-stock')
  @RequirePermission('report:read')
  async getLowStock(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
  ) {
    return this.reportsService.getLowStock(actor.organizationId, branchIds);
  }

  @Get('daily')
  @RequirePermission('report:read')
  async getDailyPerformance(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query('date') date?: string,
  ) {
    return this.reportsService.getDailyPerformance(actor.organizationId, branchIds, date);
  }

  /**
   * One row per branch in scope. `?branchId=all` compares every branch the caller
   * may reach, which is what the organisation-wide report uses.
   */
  @Get('branches')
  @RequirePermission('report:read')
  async compareBranches(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportsService.getBranchComparison(actor.organizationId, branchIds, { from, to });
  }

  @Get('trend')
  @RequirePermission('report:read')
  async getTrend(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query('granularity') granularity?: string,
    @Query('points') points?: string,
  ) {
    const parsedPoints = points ? Number(points) : undefined;
    return this.reportsService.getTrend(actor.organizationId, branchIds, {
      granularity: granularity as TrendGranularity | undefined,
      points: parsedPoints && Number.isFinite(parsedPoints) ? parsedPoints : undefined,
    });
  }
}
