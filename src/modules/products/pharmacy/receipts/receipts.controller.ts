import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ReceiptsService } from './receipts.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('pharmacy/receipts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Post()
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async create(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') actorId: string,
    @Body() dto: CreateReceiptDto,
  ) {
    const receipt = await this.receiptsService.create(organizationId, actorId, dto);
    return { data: receipt };
  }

  @Post(':id/confirm')
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  async confirm(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') actorId: string,
    @Param('id') id: string,
  ) {
    const receipt = await this.receiptsService.confirm(organizationId, id, actorId);
    return { data: receipt };
  }
}
