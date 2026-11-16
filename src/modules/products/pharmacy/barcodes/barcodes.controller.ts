import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { BarcodesService } from './barcodes.service';
import { LookupBarcodeDto } from './dto/lookup-barcode.dto';
import { UpdateBarcodeDto } from './dto/update-barcode.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';

@Controller('pharmacy/barcodes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BarcodesController {
  constructor(private readonly barcodesService: BarcodesService) {}

  @Get('lookup')
  async lookup(
    @CurrentUser('organisationId') organizationId: string,
    @Query() query: LookupBarcodeDto,
  ) {
    const result = await this.barcodesService.lookup(organizationId, query.code);
    return { data: result };
  }

  @Put('product/:productId')
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  assign(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateBarcodeDto,
  ) {
    return this.barcodesService.assign(organizationId, userId, productId, dto.barcode);
  }
}
