import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { PharmacyProfileDto, StockSettingsDto, StockStartDto } from './dto/onboarding.dto';
import { OnboardingService } from './onboarding.service';

@Controller('onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  async get(@CurrentUser('organisationId') organisationId: string) {
    return this.onboarding.get(organisationId);
  }

  @Patch('steps/1')
  @Roles('OWNER')
  async savePharmacyProfile(
    @Body() dto: PharmacyProfileDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    return this.onboarding.savePharmacyProfile(organisationId, userId, dto);
  }

  @Patch('steps/2')
  @Roles('OWNER')
  async saveStockSettings(
    @Body() dto: StockSettingsDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    return this.onboarding.saveStockSettings(organisationId, userId, dto);
  }

  @Patch('steps/3')
  @Roles('OWNER')
  async saveStaffStep(
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    return this.onboarding.saveStaffStep(organisationId, userId);
  }

  @Patch('steps/4')
  @Roles('OWNER')
  async saveStockStep(
    @Body() dto: StockStartDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    return this.onboarding.saveStockStep(organisationId, userId, dto);
  }

  @Post('sample-data')
  @HttpCode(200)
  @Roles('OWNER')
  async seedSampleData(
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    return this.onboarding.seedSampleData(organisationId, userId);
  }

  @Post('complete')
  @HttpCode(200)
  @Roles('OWNER')
  async complete(
    @CurrentUser('sub') userId: string,
    @CurrentUser('organisationId') organisationId: string,
  ) {
    return this.onboarding.complete(organisationId, userId);
  }
}
