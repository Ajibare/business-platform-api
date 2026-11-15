import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { CreateMovementDto } from './dto/create-movement.dto';
import { ListMovementsDto } from './dto/list-movements.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('pharmacy/movements')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post()
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async create(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateMovementDto,
  ) {
    const movement = await this.inventoryService.create(organizationId, userId, dto);
    return { data: movement };
  }

  @Get()
  findAll(@CurrentUser('organisationId') organizationId: string, @Query() query: ListMovementsDto) {
    return this.inventoryService.findAll(organizationId, query);
  }
}
