import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ONBOARDING_STEPS,
  buildOnboardingSummary,
  parseCompletedSteps,
  OnboardingSummary,
} from './onboarding-summary';
import {
  PharmacyProfileDto,
  StockSettingsDto,
  StockStartDto,
  StockStartOption,
} from './dto/onboarding.dto';

/** Verbatim wording required by the product brief. */
export const INVENTORY_NOTICE =
  'Imported or recorded quantities are system-recorded balances. They have not been physically verified.';

const SAMPLE_PRODUCTS = [
  { name: 'Paracetamol 500mg tablets', unit: 'tablet', threshold: 100 },
  { name: 'Amoxicillin 250mg capsules', unit: 'capsule', threshold: 60 },
  { name: 'Oral rehydration salts sachets', unit: 'sachet', threshold: 40 },
];

export interface OnboardingOverview {
  organization: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    phone: string | null;
    address: string | null;
    outletProfile: string | null;
    nearExpiryWarningDays: number;
    defaultUnit: string | null;
    defaultMinStockLevel: number | null;
  };
  progress: OnboardingSummary;
  counts: { members: number; products: number; pendingInvitations: number };
  inventoryNotice: string;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(organisationId: string): Promise<{ data: OnboardingOverview }> {
    const [organization, progress, counts] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: organisationId } }),
      this.prisma.onboardingProgress.findUnique({ where: { organizationId: organisationId } }),
      this.counts(organisationId),
    ]);
    if (!organization) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Workspace not found.' });
    }

    return {
      data: {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          timezone: organization.timezone,
          currency: organization.currency,
          phone: organization.phone,
          address: organization.address,
          outletProfile: organization.outletProfile,
          nearExpiryWarningDays: organization.nearExpiryWarningDays,
          defaultUnit: organization.defaultUnit,
          defaultMinStockLevel:
            organization.defaultMinStockLevel !== null
              ? Number(organization.defaultMinStockLevel)
              : null,
        },
        progress: buildOnboardingSummary({
          status: progress?.status,
          currentStep: progress?.currentStep,
          completedSteps: progress?.completedSteps,
          completedAt: progress?.completedAt,
          hasProfile: Boolean(organization.outletProfile),
          hasStockSettings:
            Boolean(organization.defaultUnit) || organization.defaultMinStockLevel !== null,
          staffCount: counts.members,
          productCount: counts.products,
        }),
        counts,
        inventoryNotice: INVENTORY_NOTICE,
      },
    };
  }

  async savePharmacyProfile(
    organisationId: string,
    actorId: string,
    dto: PharmacyProfileDto,
  ): Promise<{ data: OnboardingOverview }> {
    const timezone = dto.timezone?.trim() || 'Africa/Lagos';
    if (!this.isValidTimeZone(timezone)) {
      throw new BadRequestException({
        code: 'INVALID_TIMEZONE',
        message: 'Choose a valid time zone.',
        field: 'timezone',
      });
    }

    await this.prisma.organization.update({
      where: { id: organisationId },
      data: {
        name: dto.name.trim(),
        outletProfile: dto.outletProfile,
        ...(dto.address !== undefined ? { address: dto.address.trim() || null } : {}),
        timezone,
      },
    });
    await this.markStepComplete(organisationId, 1);
    await this.audit.record({
      organizationId: organisationId,
      actorId,
      action: 'ONBOARDING_STEP_SAVED',
      entityType: 'Organization',
      entityId: organisationId,
      metadata: { step: 1 },
    });

    return this.get(organisationId);
  }

  async saveStockSettings(
    organisationId: string,
    actorId: string,
    dto: StockSettingsDto,
  ): Promise<{ data: OnboardingOverview }> {
    await this.prisma.organization.update({
      where: { id: organisationId },
      data: {
        nearExpiryWarningDays: dto.nearExpiryWarningDays,
        ...(dto.defaultUnit !== undefined
          ? { defaultUnit: dto.defaultUnit.trim() || null }
          : {}),
        ...(dto.defaultMinStockLevel !== undefined
          ? { defaultMinStockLevel: dto.defaultMinStockLevel }
          : {}),
      },
    });
    await this.markStepComplete(organisationId, 2);
    await this.audit.record({
      organizationId: organisationId,
      actorId,
      action: 'ONBOARDING_STEP_SAVED',
      entityType: 'Organization',
      entityId: organisationId,
      metadata: {
        step: 2,
        nearExpiryWarningDays: dto.nearExpiryWarningDays,
      },
    });

    return this.get(organisationId);
  }

  /**
   * Step 3 is the invite step. Staff are invited through `/invitations`; this
   * only records that the owner has been through the step or skipped it.
   */
  async saveStaffStep(
    organisationId: string,
    actorId: string,
  ): Promise<{ data: OnboardingOverview }> {
    await this.markStepComplete(organisationId, 3);
    await this.audit.record({
      organizationId: organisationId,
      actorId,
      action: 'ONBOARDING_STEP_SAVED',
      entityType: 'Organization',
      entityId: organisationId,
      metadata: { step: 3 },
    });
    return this.get(organisationId);
  }

  async saveStockStep(
    organisationId: string,
    actorId: string,
    dto: StockStartDto,
  ): Promise<{ data: OnboardingOverview }> {
    if (dto.choice === 'SAMPLE') {
      await this.seedSampleProducts(organisationId, actorId);
    }
    await this.markStepComplete(organisationId, 4);
    await this.audit.record({
      organizationId: organisationId,
      actorId,
      action: 'ONBOARDING_STEP_SAVED',
      entityType: 'Organization',
      entityId: organisationId,
      metadata: { step: 4, choice: dto.choice },
    });
    return this.get(organisationId);
  }

  async seedSampleData(
    organisationId: string,
    actorId: string,
  ): Promise<{ data: { created: number; products: { id: string; name: string }[] } }> {
    const created = await this.seedSampleProducts(organisationId, actorId);
    return { data: { created: created.length, products: created } };
  }

  async complete(
    organisationId: string,
    actorId: string,
  ): Promise<{ data: { completed: true; nextPath: string; onboarding: OnboardingSummary } }> {
    const progress = await this.prisma.onboardingProgress.findUnique({
      where: { organizationId: organisationId },
    });
    const completedSteps = parseCompletedSteps(progress?.completedSteps);
    const missingRequired = ONBOARDING_STEPS.filter(
      (step) => !step.optional && !completedSteps.includes(step.step),
    ).map((step) => step.step);

    if (missingRequired.length > 0) {
      throw new BadRequestException({
        code: 'ONBOARDING_INCOMPLETE',
        message: 'Finish the pharmacy profile and stock settings before completing setup.',
        details: { missingSteps: missingRequired },
      });
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.onboardingProgress.update({
        where: { organizationId: organisationId },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          currentStep: completedSteps.length > 0 ? Math.max(...completedSteps) : 4,
        },
      }),
      this.prisma.organization.update({
        where: { id: organisationId },
        data: { onboardingCompletedAt: now },
      }),
    ]);
    await this.audit.record({
      organizationId: organisationId,
      actorId,
      action: 'ONBOARDING_COMPLETED',
      entityType: 'Organization',
      entityId: organisationId,
    });

    const overview = await this.get(organisationId);
    return {
      data: {
        completed: true,
        nextPath: '/dashboard',
        onboarding: overview.data.progress,
      },
    };
  }

  // ----------------------------------------------------------------- internals

  private async counts(organisationId: string) {
    const [members, products, pendingInvitations] = await Promise.all([
      this.prisma.membership.count({ where: { organizationId: organisationId, active: true } }),
      this.prisma.product.count({ where: { organizationId: organisationId, active: true } }),
      this.prisma.staffInvitation.count({
        where: { organizationId: organisationId, status: 'PENDING' },
      }),
    ]);
    return { members, products, pendingInvitations };
  }

  private async markStepComplete(organisationId: string, step: number): Promise<void> {
    const progress = await this.prisma.onboardingProgress.findUnique({
      where: { organizationId: organisationId },
    });
    const completed = parseCompletedSteps(progress?.completedSteps);
    if (!completed.includes(step)) completed.push(step);
    completed.sort((a, b) => a - b);

    const nextStep =
      ONBOARDING_STEPS.find((definition) => !completed.includes(definition.step))?.step ?? 4;

    await this.prisma.onboardingProgress.upsert({
      where: { organizationId: organisationId },
      create: {
        organizationId: organisationId,
        currentStep: nextStep,
        completedSteps: completed,
        status: 'IN_PROGRESS',
      },
      update: {
        currentStep: nextStep,
        completedSteps: completed,
        ...(progress?.status === 'COMPLETED' ? {} : { status: 'IN_PROGRESS' }),
      },
    });
  }

  /**
   * Sample products are real rows with `isSample` set: the UI labels them, the
   * stock engine treats them as normal products, and no quantities are invented.
   */
  private async seedSampleProducts(
    organisationId: string,
    actorId: string,
  ): Promise<{ id: string; name: string }[]> {
    const existing = await this.prisma.product.findMany({
      where: { organizationId: organisationId, isSample: true },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing.length > 0) return existing;

    const organization = await this.prisma.organization.findUnique({
      where: { id: organisationId },
      select: { defaultUnit: true },
    });

    const products: { id: string; name: string }[] = [];
    for (const sample of SAMPLE_PRODUCTS) {
      const product = await this.prisma.product.create({
        data: {
          organizationId: organisationId,
          name: sample.name,
          normalizedName: sample.name.toLowerCase(),
          unit: organization?.defaultUnit ?? sample.unit,
          reorderThreshold: sample.threshold,
          isSample: true,
        },
        select: { id: true, name: true },
      });
      products.push(product);
    }

    if (actorId) {
      await this.audit.record({
        organizationId: organisationId,
        actorId,
        action: 'SAMPLE_DATA_SEEDED',
        entityType: 'Organization',
        entityId: organisationId,
        metadata: { created: products.length },
      });
    }

    return products;
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

export type { StockStartOption };
