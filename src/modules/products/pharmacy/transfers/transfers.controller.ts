import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TransfersService } from './transfers.service';
import { CreateTransferDto } from './dto/create-transfer.dto';
import {
  ListTransfersDto,
  ReceiveTransferDto,
  RejectTransferDto,
} from './dto/list-transfers.dto';
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

@Controller('pharmacy/transfers')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class TransfersController {
  constructor(
    private readonly transfersService: TransfersService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Get()
  @RequirePermission('transfer:read')
  async findAll(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: ListTransfersDto,
  ) {
    return this.transfersService.findAll(actor, branchIds, query);
  }

  @Get(':id')
  @RequirePermission('transfer:read')
  async findOne(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Param('id') id: string,
  ) {
    return this.transfersService.findOne(actor, branchIds, id);
  }

  @Post()
  @RequirePermission('transfer:request')
  async create(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch() scope: BranchScope,
    @Body() dto: CreateTransferDto,
  ) {
    // Default to the branch the caller is working in when they did not pick one.
    const fromBranchId = dto.fromBranchId ?? (await this.branchAccess.writableBranchId(actor, scope));
    return this.transfersService.create(actor, { ...dto, fromBranchId });
  }

  @Post(':id/submit')
  @RequirePermission('transfer:request')
  async submit(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.transfersService.submit(actor, id);
  }

  @Post(':id/approve')
  @RequirePermission('transfer:approve')
  async approve(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.transfersService.approve(actor, id);
  }

  @Post(':id/reject')
  @RequirePermission('transfer:approve')
  async reject(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() dto: RejectTransferDto,
  ) {
    return this.transfersService.reject(actor, id, dto.reason);
  }

  @Post(':id/cancel')
  @RequirePermission('transfer:request')
  async cancel(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.transfersService.cancel(actor, id);
  }

  @Post(':id/dispatch')
  @RequirePermission('transfer:dispatch')
  async dispatch(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.transfersService.dispatch(actor, id);
  }

  @Post(':id/receive')
  @RequirePermission('transfer:receive')
  async receive(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() dto: ReceiveTransferDto,
  ) {
    return this.transfersService.receive(actor, id, dto);
  }
}
