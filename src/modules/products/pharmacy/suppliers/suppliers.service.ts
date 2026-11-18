import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { ListSuppliersDto } from './dto/list-suppliers.dto';

export interface SupplierRecord {
  id: string;
  organizationId: string;
  name: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface SupplierRow {
  id: string;
  organizationId: string;
  name: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, dto: CreateSupplierDto): Promise<SupplierRecord> {
    const supplier = await this.prisma.supplier.create({
      data: {
        organizationId,
        name: dto.name,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        active: dto.active ?? true,
      },
    });

    return this.toRecord(supplier);
  }

  async findAll(
    organizationId: string,
    query: ListSuppliersDto,
  ): Promise<{ data: SupplierRecord[]; meta: { total: number; limit: number; offset: number } }> {
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
              { phone: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    // The count has to use the same filter as the page, otherwise a search
    // reports the size of the whole list.
    const [suppliers, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return {
      data: suppliers.map((supplier) => this.toRecord(supplier)),
      meta: { total, limit, offset },
    };
  }

  async findOne(organizationId: string, id: string): Promise<SupplierRecord> {
    const supplier = await this.prisma.supplier.findFirst({ where: { id, organizationId } });
    if (!supplier) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Supplier not found' });
    }

    return this.toRecord(supplier);
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateSupplierDto,
  ): Promise<SupplierRecord> {
    const existing = await this.prisma.supplier.findFirst({ where: { id, organizationId } });
    if (!existing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Supplier not found' });
    }

    const updated = await this.prisma.supplier.update({
      where: { id: existing.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });

    return this.toRecord(updated);
  }

  private toRecord(supplier: SupplierRow): SupplierRecord {
    return {
      id: supplier.id,
      organizationId: supplier.organizationId,
      name: supplier.name,
      phone: supplier.phone,
      email: supplier.email,
      active: supplier.active,
      createdAt: supplier.createdAt,
      updatedAt: supplier.updatedAt,
    };
  }
}
