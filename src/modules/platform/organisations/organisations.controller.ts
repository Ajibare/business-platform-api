import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../../../common/decorators/current-actor.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import type { RequestActor } from '../branches/branch-access.service';
import { OrganisationsService } from './organisations.service';
import { UpdateOrganisationSettingsDto } from './dto/organisation-settings.dto';

@Controller('organisations/settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrganisationsController {
  constructor(private readonly organisationsService: OrganisationsService) {}

  @Get()
  @RequirePermission('organisation:read')
  getSettings(@CurrentActor() actor: RequestActor) {
    return this.organisationsService.getSettings(actor.organizationId);
  }

  /** Organisation-wide preferences, including the transfer approval policy. */
  @Patch()
  @RequirePermission('organisation:manage')
  updateSettings(
    @CurrentActor() actor: RequestActor,
    @Body() dto: UpdateOrganisationSettingsDto,
  ) {
    return this.organisationsService.updateSettings(actor.organizationId, actor.userId, dto);
  }
}
