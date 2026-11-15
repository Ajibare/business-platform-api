import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ExpiryService } from './expiry.service';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';

@Controller('pharmacy/expiry')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExpiryController {
  constructor(private readonly expiryService: ExpiryService) {}

  @Get('near')
  async findNear(@CurrentUser('organisationId') organizationId: string, @Query('days') days?: string) {
    const parsed = days ? Number(days) : 30;
    return this.expiryService.findNear(organizationId, parsed);
  }

  @Get('expired')
  async findExpired(@CurrentUser('organisationId') organizationId: string) {
    return this.expiryService.findExpired(organizationId);
  }

  @Get('unknown')
  async findUnknown(@CurrentUser('organisationId') organizationId: string) {
    return this.expiryService.findUnknown(organizationId);
  }
}
