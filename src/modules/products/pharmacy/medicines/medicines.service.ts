import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { CreateMedicineDto } from './dto/create-medicine.dto';
import { UpdateMedicineDto } from './dto/update-medicine.dto';
import { ListMedicinesDto } from './dto/list-medicines.dto';
import { BarcodesService } from '../barcodes/barcodes.service';
import { isValidBarcode, normalizeBarcode } from '../barcodes/barcode.util';
import { normalizeProductName } from '../../../../common/utils/product-name';

export interface MedicineRecord {
  id: string;
  organizationId: string;
  name: string;
  normalizedName: string;
  brand: string | null;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  unit: string;
  barcode: string | null;
  reorderThreshold: number | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  totalRecordedQuantity: number;
}

interface MedicineRow {
  id: string;
  organizationId: string;
  name: string;
  normalizedName: string;
  brand: string | null;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  unit: string;
  barcode: string | null;
  reorderThreshold: { toNumber(): number } | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class MedicinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly barcodesService: BarcodesService,
  ) {}

  async create(organizationId: string, actorId: string, dto: CreateMedicineDto): Promise<MedicineRecord> {
    const normalizedName = dto.normalizedName ?? MedicinesService.normalize(dto.name);

    const duplicate = await this.prisma.product.findFirst({
      where: { organizationId, normalizedName },
    });
    if (duplicate) {
      throw new ConflictException({
        code: 'DUPLICATE_REQUEST',
        message: 'A product named already exists for this pharmacy.',
      });
    }

    const barcode = dto.barcode ? this.normalizeBarcodeOrThrow(dto.barcode) : null;
    if (barcode) {
      await this.barcodesService.assertAvailable(organizationId, barcode);
    }

    const product = await this.prisma.product.create({
      data: {
        organizationId,
        name: dto.name,
        normalizedName,
        brand: dto.brand ?? null,
        strength: dto.strength ?? null,
        dosageForm: dto.dosageForm ?? null,
        packSize: dto.packSize ?? null,
        unit: dto.unit,
        barcode,
        reorderThreshold: dto.reorderThreshold ?? null,
        active: dto.active ?? true,
      },
    });

    const balance = await this.prisma.batchBalance.findFirst({
      where: { organizationId, batch: { productId: product.id } },
      select: { quantity: true },
    });

    return this.toRecord(product, balance ? this.toQuantity(balance.quantity) : 0);
  }

  async findAll(
    organizationId: string,
    branchIds: string[],
    query: ListMedicinesDto,
  ): Promise<{ data: MedicineRecord[]; meta: { total: number; limit: number; offset: number } }> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const search = query.q?.trim();

    const where = {
      organizationId,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { brand: { contains: search, mode: 'insensitive' as const } },
              { strength: { contains: search, mode: 'insensitive' as const } },
              { dosageForm: { contains: search, mode: 'insensitive' as const } },
              { barcode: { contains: search.toUpperCase(), mode: 'insensitive' as const } },
              { normalizedName: { contains: search.toLowerCase(), mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    // The count has to use the same filter as the page, otherwise a search
    // reports the size of the whole catalogue.
    const [medicines, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.product.count({ where }),
    ]);

    const medicineIds = medicines.map((medicine) => medicine.id);
    const balances = medicineIds.length
      ? await this.prisma.batchBalance.findMany({
          where: {
            organizationId,
            // The catalogue is shared but quantities are per branch, so the
            // list never adds another location's stock to the column shown.
            batch: { productId: { in: medicineIds }, branchId: { in: branchIds } },
          },
          select: { batch: { select: { productId: true } }, quantity: true },
        })
      : [];
    const quantitiesByProduct = new Map<string, number>();
    for (const balance of balances) {
      const productId = balance.batch.productId;
      quantitiesByProduct.set(
        productId,
        (quantitiesByProduct.get(productId) ?? 0) + this.toQuantity(balance.quantity),
      );
    }

    const items: MedicineRecord[] = medicines.map((medicine) => ({
      id: medicine.id,
      organizationId: medicine.organizationId,
      name: medicine.name,
      normalizedName: medicine.normalizedName,
      brand: medicine.brand,
      strength: medicine.strength,
      dosageForm: medicine.dosageForm,
      packSize: medicine.packSize,
      unit: medicine.unit,
      barcode: medicine.barcode,
      reorderThreshold:
        medicine.reorderThreshold !== null ? medicine.reorderThreshold.toNumber() : null,
      active: medicine.active,
      createdAt: medicine.createdAt,
      updatedAt: medicine.updatedAt,
      totalRecordedQuantity: quantitiesByProduct.get(medicine.id) ?? 0,
    }));

    return { data: items, meta: { total, limit, offset } };
  }

  async findOne(organizationId: string, branchIds: string[], id: string): Promise<MedicineRecord> {
    const medicine = await this.prisma.product.findFirst({ where: { id, organizationId } });
    if (!medicine) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Medicine not found' });
    }
    const quantity = await this.stockInBranches(organizationId, branchIds, medicine.id);

    return this.toRecord(medicine, quantity);
  }

  async update(
    organizationId: string,
    branchIds: string[],
    id: string,
    dto: UpdateMedicineDto,
  ): Promise<MedicineRecord> {
    const existing = await this.prisma.product.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Medicine not found' });
    }

    const normalizedName =
      dto.normalizedName ?? (dto.name ? MedicinesService.normalize(dto.name) : existing.normalizedName);

    const duplicate = await this.prisma.product.findFirst({
      where: { organizationId, normalizedName, NOT: { id: existing.id } },
    });
    if (duplicate) {
      throw new ConflictException({
        code: 'DUPLICATE_REQUEST',
        message: 'A product named already exists for this pharmacy.',
      });
    }

    const updated = await this.prisma.product.update({
      where: { id: existing.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.normalizedName !== undefined ? { normalizedName } : {}),
        ...(dto.brand !== undefined ? { brand: dto.brand } : {}),
        ...(dto.strength !== undefined ? { strength: dto.strength } : {}),
        ...(dto.dosageForm !== undefined ? { dosageForm: dto.dosageForm } : {}),
        ...(dto.packSize !== undefined ? { packSize: dto.packSize } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.barcode !== undefined ? { barcode: await this.resolveBarcode(organizationId, existing.id, dto.barcode) } : {}),
        ...(dto.reorderThreshold !== undefined ? { reorderThreshold: dto.reorderThreshold } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });

    const quantity = await this.stockInBranches(organizationId, branchIds, updated.id);

    return this.toRecord(updated, quantity);
  }

  /** Stock of one medicine across the branches the caller may read. */
  private async stockInBranches(
    organizationId: string,
    branchIds: string[],
    productId: string,
  ): Promise<number> {
    const balances = await this.prisma.batchBalance.findMany({
      where: { organizationId, batch: { productId, branchId: { in: branchIds } } },
      select: { quantity: true },
    });
    return balances.reduce((total, balance) => total + this.toQuantity(balance.quantity), 0);
  }

  private toRecord(medicine: MedicineRow, totalRecordedQuantity: number): MedicineRecord {
    return {
      id: medicine.id,
      organizationId: medicine.organizationId,
      name: medicine.name,
      normalizedName: medicine.normalizedName,
      brand: medicine.brand,
      strength: medicine.strength,
      dosageForm: medicine.dosageForm,
      packSize: medicine.packSize,
      unit: medicine.unit,
      barcode: medicine.barcode,
      reorderThreshold: medicine.reorderThreshold !== null ? medicine.reorderThreshold.toNumber() : null,
      active: medicine.active,
      createdAt: medicine.createdAt,
      updatedAt: medicine.updatedAt,
      totalRecordedQuantity,
    };
  }

  private normalizeBarcodeOrThrow(value: string): string {
    const barcode = normalizeBarcode(value);
    if (!isValidBarcode(barcode)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message:
          'Barcodes must be 4 to 64 characters and may only contain letters, numbers, dot, dash or underscore.',
      });
    }
    return barcode;
  }

  private async resolveBarcode(
    organizationId: string,
    productId: string,
    value: string | null,
  ): Promise<string | null> {
    if (value === null || value.trim() === '') return null;
    const barcode = this.normalizeBarcodeOrThrow(value);
    await this.barcodesService.assertAvailable(organizationId, barcode, productId);
    return barcode;
  }

  private static normalize(name: string): string {
    return normalizeProductName(name);
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}
