import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ImportsService } from './imports.service';
import { CreateImportDto } from './dto/create-import.dto';
import { ListImportsDto } from './dto/list-imports.dto';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../common/guards/roles.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';

@Controller('pharmacy/imports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Get('templates/:type')
  async template(@Param('type') type: string, @Query('format') format?: string) {
    const file = await this.importsService.getTemplateFile(type, format);
    return { data: file };
  }

  @Get('schema/:type')
  schema(@Param('type') type: string) {
    return this.importsService.getSchema(type);
  }

  @Get()
  list(
    @CurrentUser('organisationId') organizationId: string,
    @Query() query: ListImportsDto,
  ) {
    return this.importsService.list(organizationId, query);
  }

  @Post()
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  validate(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateImportDto,
  ) {
    return this.importsService.validateAndStore(organizationId, userId, dto);
  }

  @Get(':id/errors')
  async errors(
    @CurrentUser('organisationId') organizationId: string,
    @Param('id') id: string,
  ) {
    const content = await this.importsService.errorReportCsv(organizationId, id);
    return {
      data: {
        filename: `import-${id}-errors.csv`,
        contentType: 'text/csv;charset=utf-8',
        content,
      },
    };
  }

  @Get(':id')
  findOne(
    @CurrentUser('organisationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.importsService.findOne(organizationId, id);
  }

  @Post(':id/confirm')
  @Roles(Role.OWNER, Role.MANAGER, Role.INVENTORY_STAFF)
  confirm(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ) {
    return this.importsService.confirm(organizationId, userId, id);
  }
}
