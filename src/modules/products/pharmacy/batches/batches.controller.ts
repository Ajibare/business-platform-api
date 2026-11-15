import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { ListBatchesDto } from './dto/list-batches.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('pharmacy/batches')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  @Get()
  findAll(@CurrentUser('organisationId') organizationId: string, @Query() query: ListBatchesDto) {
    return this.batchesService.findAll(organizationId, query);
  }

  @Post()
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async create(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateBatchDto,
  ) {
    const batch = await this.batchesService.create(organizationId, userId, dto);
    return { data: batch };
  }

  @Get(':id')
  async findOne(@CurrentUser('organisationId') organizationId: string, @Param('id') id: string) {
    const batch = await this.batchesService.findOne(organizationId, id);
    return { data: batch };
  }
}
