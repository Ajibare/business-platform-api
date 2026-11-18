import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ImportsService } from './imports.service';
import { CreateImportDto } from './dto/create-import.dto';
import { ListImportsDto } from './dto/list-imports.dto';
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

@Controller('pharmacy/imports')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class ImportsController {
  constructor(
    private readonly importsService: ImportsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Get('templates/:type')
  @RequirePermission('inventory:read')
  async template(@Param('type') type: string, @Query('format') format?: string) {
    const file = await this.importsService.getTemplateFile(type, format);
    return { data: file };
  }

  @Get('schema/:type')
  @RequirePermission('inventory:read')
  schema(@Param('type') type: string) {
    return this.importsService.getSchema(type);
  }

  @Get()
  @RequirePermission('inventory:read')
  list(
    @CurrentActor() actor: RequestActor,
    @Query() query: ListImportsDto,
  ) {
    return this.importsService.list(actor.organizationId, query);
  }

  /**
   * Validates a file and stores the accepted rows. The branch is captured on the
   * job so the confirmation step writes stock into the same branch even if the
   * browser switched branches in between.
   */
  @Post()
  @RequirePermission('inventory:receive')
  async validate(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: CreateImportDto,
  ) {
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    return this.importsService.validateAndStore(actor.organizationId, actor.userId, branchId, dto);
  }

  @Get(':id/errors')
  @RequirePermission('inventory:read')
  async errors(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ) {
    const content = await this.importsService.errorReportCsv(actor.organizationId, id);
    return {
      data: {
        filename: `import-${id}-errors.csv`,
        contentType: 'text/csv;charset=utf-8',
        content,
      },
    };
  }

  @Get(':id')
  @RequirePermission('inventory:read')
  findOne(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ) {
    return this.importsService.findOne(actor.organizationId, id);
  }

  @Post(':id/confirm')
  @RequirePermission('inventory:receive')
  async confirm(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Param('id') id: string,
  ) {
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    return this.importsService.confirm(actor.organizationId, actor.userId, branchId, id);
  }
}
