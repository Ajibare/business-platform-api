import { BadRequestException, Body, Controller, Get, Param, ParseEnumPipe, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from './permissions.service';
import { SetMemberPermissionsDto, SetRolePermissionsDto } from './dto/permissions.dto';

@Controller('permissions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PermissionsController {
  constructor(
    private readonly permissionsService: PermissionsService,
    private readonly auditService: AuditService,
  ) {}

  /** Every permission the platform understands, grouped for the editor. */
  @Get('catalogue')
  @RequirePermission('staff:read')
  catalogue() {
    return this.permissionsService.describe();
  }

  /** What each role may currently do in this organisation. */
  @Get('roles')
  @RequirePermission('staff:read')
  roles(@CurrentUser('organisationId') organizationId: string) {
    return this.permissionsService.getRoleMatrix(organizationId);
  }

  @Put('roles/:role')
  @RequirePermission('staff:permissions')
  async setRole(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('role', new ParseEnumPipe(Role)) role: Role,
    @Body() dto: SetRolePermissionsDto,
  ) {
    const result = await this.permissionsService.setRolePermissions(
      organizationId,
      role,
      dto.permissions,
    );
    await this.auditService.record({
      organizationId,
      actorId: userId,
      action: 'ROLE_PERMISSIONS_UPDATED',
      entityType: 'Role',
      entityId: role,
      metadata: { permissionCount: result.data.permissions.length },
    });
    return result;
  }

  @Get('members/:userId')
  @RequirePermission('staff:read')
  memberOverrides(
    @CurrentUser('organisationId') organizationId: string,
    @Param('userId') userId: string,
  ) {
    return this.permissionsService.getMemberOverrides(organizationId, userId);
  }

  @Put('members/:userId')
  @RequirePermission('staff:permissions')
  async setMemberOverrides(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') actorId: string,
    @Param('userId') userId: string,
    @Body() dto: SetMemberPermissionsDto,
  ) {
    if (actorId === userId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'You cannot change your own permissions.',
      });
    }

    const result = await this.permissionsService.setMemberOverrides(organizationId, userId, {
      grants: dto.grants,
      denies: dto.denies,
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'MEMBER_PERMISSIONS_UPDATED',
      entityType: 'Membership',
      entityId: userId,
      metadata: { grants: dto.grants ?? [], denies: dto.denies ?? [] },
    });

    return result;
  }
}
