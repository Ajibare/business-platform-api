import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentBranch } from '../../../common/decorators/current-branch.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { BranchScopeGuard } from '../../../common/guards/branch-scope.guard';

@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Staff activity and audit trail. A member restricted to one branch sees that
   * branch's entries plus organisation-wide ones, never another branch's.
   */
  @Get()
  @RequirePermission('audit:read')
  findAll(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query('limit') limit?: string,
  ) {
    return this.auditService.findAll(organizationId, limit ? Number(limit) : 100, branchIds);
  }
}
