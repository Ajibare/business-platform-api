import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';

@Controller('pharmacy/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('dashboard')
  async getDashboard(
    @CurrentUser('organisationId') organizationId: string,
    @Query('warningDays') warningDays?: string,
  ) {
    const parsed = warningDays ? Number(warningDays) : 30;
    return this.reportsService.getDashboard(organizationId, parsed);
  }

  @Get('low-stock')
  async getLowStock(@CurrentUser('organisationId') organizationId: string) {
    return this.reportsService.getLowStock(organizationId);
  }

  @Get('daily')
  async getDailyPerformance(
    @CurrentUser('organisationId') organizationId: string,
    @Query('date') date?: string,
  ) {
    return this.reportsService.getDailyPerformance(organizationId, date);
  }
}
