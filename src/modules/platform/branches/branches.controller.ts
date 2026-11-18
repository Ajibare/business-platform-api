import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { BranchStatus } from '@prisma/client';
import { CurrentActor } from '../../../common/decorators/current-actor.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { BranchesService } from './branches.service';
import type { RequestActor } from './branch-access.service';
import {
  AssignBranchManagerDto,
  AssignBranchStaffDto,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto';

@Controller('branches')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @RequirePermission('branch:read')
  findAll(@CurrentActor() actor: RequestActor) {
    return this.branchesService.findAll(actor);
  }

  @Post()
  @RequirePermission('branch:manage')
  create(@CurrentActor() actor: RequestActor, @Body() dto: CreateBranchDto) {
    return this.branchesService.create(actor, dto);
  }

  @Get(':id')
  @RequirePermission('branch:read')
  findOne(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.branchesService.findOne(actor, id);
  }

  @Patch(':id')
  @RequirePermission('branch:manage')
  update(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchesService.update(actor, id, dto);
  }

  @Post(':id/activate')
  @RequirePermission('branch:manage')
  activate(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.branchesService.setStatus(actor, id, BranchStatus.ACTIVE);
  }

  @Post(':id/deactivate')
  @RequirePermission('branch:manage')
  deactivate(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.branchesService.setStatus(actor, id, BranchStatus.INACTIVE);
  }

  @Put(':id/manager')
  @RequirePermission('branch:manage')
  assignManager(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() dto: AssignBranchManagerDto,
  ) {
    return this.branchesService.assignManager(actor, id, dto.managerUserId ?? null);
  }

  @Put(':id/staff')
  @RequirePermission('branch:manage')
  assignStaff(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() dto: AssignBranchStaffDto,
  ) {
    return this.branchesService.assignStaff(actor, id, dto);
  }

  @Delete(':id/staff/:userId')
  @RequirePermission('branch:manage')
  removeStaff(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.branchesService.removeStaff(actor, id, userId);
  }
}
