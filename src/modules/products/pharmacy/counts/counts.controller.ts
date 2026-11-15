import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { CountsService } from './counts.service';
import { CreateCountDto } from './dto/create-count.dto';
import { AddCountLineDto } from './dto/add-count-line.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('pharmacy/counts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CountsController {
  constructor(private readonly countsService: CountsService) {}

  @Post()
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async create(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateCountDto,
  ) {
    const count = await this.countsService.create(organizationId, userId, dto);
    return { data: count };
  }

  @Post(':id/lines')
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async addLine(
    @CurrentUser('organisationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: AddCountLineDto,
  ) {
    const line = await this.countsService.addLine(organizationId, id, dto);
    return { data: line };
  }

  @Post(':id/submit')
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async submit(@CurrentUser('organisationId') organizationId: string, @Param('id') id: string) {
    const count = await this.countsService.submit(organizationId, id);
    return { data: count };
  }

  @Post(':id/approve')
  @Roles(Role.OWNER, Role.MANAGER)
  async approve(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') approverId: string,
    @Param('id') id: string,
  ) {
    const count = await this.countsService.approve(organizationId, id, approverId);
    return { data: count };
  }
}
