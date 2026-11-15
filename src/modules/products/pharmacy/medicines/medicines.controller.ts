import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MedicinesService } from './medicines.service';
import { CreateMedicineDto } from './dto/create-medicine.dto';
import { UpdateMedicineDto } from './dto/update-medicine.dto';
import { ListMedicinesDto } from './dto/list-medicines.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('pharmacy/medicines')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MedicinesController {
  constructor(private readonly medicinesService: MedicinesService) {}

  @Get()
  findAll(@CurrentUser('organisationId') organizationId: string, @Query() query: ListMedicinesDto) {
    return this.medicinesService.findAll(organizationId, query);
  }

  @Post()
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async create(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateMedicineDto,
  ) {
    const medicine = await this.medicinesService.create(organizationId, userId, dto);
    return { data: medicine };
  }

  @Get(':id')
  findOne(@CurrentUser('organisationId') organizationId: string, @Param('id') id: string) {
    return this.medicinesService.findOne(organizationId, id);
  }

  @Patch(':id')
  @Roles(Role.OWNER, Role.MANAGER)
  async update(
    @CurrentUser('organisationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateMedicineDto,
  ) {
    const medicine = await this.medicinesService.update(organizationId, id, dto);
    return { data: medicine };
  }
}
