import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpdateOrganisationSettingsDto } from './dto/organisation-settings.dto';

export interface OrganisationSettings {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  nearExpiryWarningDays: number;
  requireTransferApproval: boolean;
}

@Injectable()
export class OrganisationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async getSettings(organizationId: string): Promise<{ data: OrganisationSettings }> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        timezone: true,
        currency: true,
        nearExpiryWarningDays: true,
        requireTransferApproval: true,
      },
    });
    if (!organization) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Workspace not found.' });
    }
    return { data: organization };
  }

  async updateSettings(
    organizationId: string,
    actorId: string,
    dto: UpdateOrganisationSettingsDto,
  ): Promise<{ data: OrganisationSettings }> {
    if (dto.timezone !== undefined && !this.isValidTimeZone(dto.timezone)) {
      throw new BadRequestException({
        code: 'INVALID_TIMEZONE',
        message: 'Choose a valid time zone.',
        field: 'timezone',
      });
    }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone.trim() } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency.trim().toUpperCase() } : {}),
        ...(dto.nearExpiryWarningDays !== undefined
          ? { nearExpiryWarningDays: dto.nearExpiryWarningDays }
          : {}),
        ...(dto.requireTransferApproval !== undefined
          ? { requireTransferApproval: dto.requireTransferApproval }
          : {}),
      },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'ORGANISATION_SETTINGS_UPDATED',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { ...dto },
    });

    return this.getSettings(organizationId);
  }

  private isValidTimeZone(value: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }
}
