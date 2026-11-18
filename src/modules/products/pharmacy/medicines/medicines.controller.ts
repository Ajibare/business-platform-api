import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MedicinesService } from './medicines.service';
import { BulkMedicinesService } from './bulk-medicines.service';
import { CreateMedicineDto } from './dto/create-medicine.dto';
import { BulkCreateMedicinesDto } from './dto/bulk-create-medicines.dto';
import { UpdateMedicineDto } from './dto/update-medicine.dto';
import { ListMedicinesDto } from './dto/list-medicines.dto';
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

@Controller('pharmacy/medicines')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class MedicinesController {
  constructor(
    private readonly medicinesService: MedicinesService,
    private readonly bulkMedicinesService: BulkMedicinesService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Get()
  @RequirePermission('product:read')
  findAll(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: ListMedicinesDto,
  ) {
    return this.medicinesService.findAll(actor.organizationId, branchIds, query);
  }

  @Post()
  @RequirePermission('product:manage')
  async create(
    @CurrentActor() actor: RequestActor,
    @Body() dto: CreateMedicineDto,
  ) {
    const medicine = await this.medicinesService.create(actor.organizationId, actor.userId, dto);
    return { data: medicine };
  }

  /**
   * Creates up to 100 medicines, with optional opening batches, in one request.
   * Opening stock lands in the branch the request is working in.
   */
  @Post('bulk')
  @RequirePermission('product:manage')
  async createMany(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: BulkCreateMedicinesDto,
  ) {
    const branchId = await this.branchAccess.writableBranchId(actor, scope);
    const result = await this.bulkMedicinesService.createMany(
      actor.organizationId,
      branchId,
      actor.userId,
      dto,
    );
    return { data: result };
  }

  @Get(':id')
  @RequirePermission('product:read')
  findOne(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    return this.medicinesService.findOne(actor.organizationId, branchIds, id);
  }

  @Patch(':id')
  @RequirePermission('product:manage')
  async update(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
    @Body() dto: UpdateMedicineDto,
  ) {
    const medicine = await this.medicinesService.update(
      actor.organizationId,
      branchIds,
      id,
      dto,
    );
    return { data: medicine };
  }
}
