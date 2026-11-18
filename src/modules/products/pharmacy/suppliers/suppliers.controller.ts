import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { ListSuppliersDto } from './dto/list-suppliers.dto';
import { CurrentActor } from '../../../../common/decorators/current-actor.decorator';
import { RequirePermission } from '../../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../../common/guards/permissions.guard';
import type { RequestActor } from '../../../platform/branches/branch-access.service';

/** Suppliers belong to the organisation, so these endpoints are not branch-scoped. */
@Controller('pharmacy/suppliers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @RequirePermission('supplier:read')
  findAll(
    @CurrentActor() actor: RequestActor,
    @Query() query: ListSuppliersDto,
  ) {
    return this.suppliersService.findAll(actor.organizationId, query);
  }

  @Post()
  @RequirePermission('supplier:manage')
  async create(
    @CurrentActor() actor: RequestActor,
    @Body() dto: CreateSupplierDto,
  ) {
    const supplier = await this.suppliersService.create(actor.organizationId, dto);
    return { data: supplier };
  }

  @Get(':id')
  @RequirePermission('supplier:read')
  findOne(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.suppliersService.findOne(actor.organizationId, id);
  }

  @Patch(':id')
  @RequirePermission('supplier:manage')
  async update(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    const supplier = await this.suppliersService.update(actor.organizationId, id, dto);
    return { data: supplier };
  }
}
