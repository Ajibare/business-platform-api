import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MedicinesService } from './medicines.service';
import { BulkMedicinesService } from './bulk-medicines.service';
import { CreateMedicineDto } from './dto/create-medicine.dto';
import { BulkCreateMedicinesDto } from './dto/bulk-create-medicines.dto';
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
  constructor(
    private readonly medicinesService: MedicinesService,
    private readonly bulkMedicinesService: BulkMedicinesService,
  ) {}

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

  /**
   * Creates up to 100 medicines, with optional opening batches, in one request.
   * Each row succeeds or fails on its own and the response reports both.
   */
  @Post('bulk')
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async createMany(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: BulkCreateMedicinesDto,
  ) {
    const result = await this.bulkMedicinesService.createMany(organizationId, userId, dto);
    return { data: result };
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
