import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MembershipStatus } from '@prisma/client';
import { CurrentActor } from '../../../common/decorators/current-actor.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import type { RequestActor } from '../branches/branch-access.service';
import { StaffService } from './staff.service';
import {
  StaffActivityQueryDto,
  StaffListQueryDto,
  StaffStatusDto,
  UpdateStaffDto,
} from './dto/staff.dto';

@Controller('staff')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @RequirePermission('staff:read')
  findAll(@CurrentActor() actor: RequestActor, @Query() query: StaffListQueryDto) {
    return this.staffService.findAll(actor, query);
  }

  @Get(':userId')
  @RequirePermission('staff:read')
  findOne(@CurrentActor() actor: RequestActor, @Param('userId') userId: string) {
    return this.staffService.findOne(actor, userId);
  }

  @Patch(':userId')
  @RequirePermission('staff:manage')
  update(
    @CurrentActor() actor: RequestActor,
    @Param('userId') userId: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.staffService.update(actor, userId, dto);
  }

  @Post(':userId/suspend')
  @RequirePermission('staff:manage')
  suspend(
    @CurrentActor() actor: RequestActor,
    @Param('userId') userId: string,
    @Body() dto: StaffStatusDto,
  ) {
    return this.staffService.setStatus(actor, userId, MembershipStatus.SUSPENDED, dto.reason);
  }

  @Post(':userId/deactivate')
  @RequirePermission('staff:manage')
  deactivate(
    @CurrentActor() actor: RequestActor,
    @Param('userId') userId: string,
    @Body() dto: StaffStatusDto,
  ) {
    return this.staffService.setStatus(actor, userId, MembershipStatus.DEACTIVATED, dto.reason);
  }

  @Post(':userId/activate')
  @RequirePermission('staff:manage')
  activate(@CurrentActor() actor: RequestActor, @Param('userId') userId: string) {
    return this.staffService.setStatus(actor, userId, MembershipStatus.ACTIVE);
  }

  @Get(':userId/activity')
  @RequirePermission('audit:read')
  activity(
    @CurrentActor() actor: RequestActor,
    @Param('userId') userId: string,
    @Query() query: StaffActivityQueryDto,
  ) {
    return this.staffService.activity(actor, userId, query.limit);
  }

  @Delete(':userId')
  @RequirePermission('staff:manage')
  remove(
    @CurrentActor() actor: RequestActor,
    @Param('userId') userId: string,
    @Body() dto: StaffStatusDto,
  ) {
    return this.staffService.remove(actor, userId, dto.reason);
  }
}
