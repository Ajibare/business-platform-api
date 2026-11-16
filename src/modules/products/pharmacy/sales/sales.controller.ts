import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';

@Controller('pharmacy/sales')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  findAll(
    @CurrentUser('organisationId') organizationId: string,
    @Query() query: ListSalesDto,
  ) {
    return this.salesService.findAll(organizationId, query);
  }

  @Get(':id')
  findOne(@CurrentUser('organisationId') organizationId: string, @Param('id') id: string) {
    return this.salesService.findOne(organizationId, id);
  }

  @Post()
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  create(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateSaleDto,
  ) {
    return this.salesService.create(organizationId, userId, dto);
  }

  @Post(':id/void')
  @Roles(Role.OWNER, Role.MANAGER)
  void(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ) {
    return this.salesService.void(organizationId, userId, id);
  }

  @Post(':id/returns')
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  recordReturn(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: CreateSaleReturnDto,
  ) {
    return this.salesService.recordReturn(organizationId, userId, id, dto);
  }
}