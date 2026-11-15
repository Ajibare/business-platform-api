import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { ListSuppliersDto } from './dto/list-suppliers.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('pharmacy/suppliers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  findAll(
    @CurrentUser('organisationId') organizationId: string,
    @Query() query: ListSuppliersDto,
  ) {
    return this.suppliersService.findAll(organizationId, query);
  }

  @Post()
  @Roles(Role.OWNER, Role.MANAGER)
  async create(
    @CurrentUser('organisationId') organizationId: string,
    @Body() dto: CreateSupplierDto,
  ) {
    const supplier = await this.suppliersService.create(organizationId, dto);
    return { data: supplier };
  }

  @Get(':id')
  findOne(@CurrentUser('organisationId') organizationId: string, @Param('id') id: string) {
    return this.suppliersService.findOne(organizationId, id);
  }

  @Patch(':id')
  @Roles(Role.OWNER, Role.MANAGER)
  async update(
    @CurrentUser('organisationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    const supplier = await this.suppliersService.update(organizationId, id, dto);
    return { data: supplier };
  }
}
