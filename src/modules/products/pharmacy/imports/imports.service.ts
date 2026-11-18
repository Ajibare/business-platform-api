import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { AuditService } from '../../../platform/audit/audit.service';
import { localDateKey } from '../../../../common/utils/time';
import { normalizeProductName } from '../../../../common/utils/product-name';
import { CsvRecord, parseCsv, toCsv } from './csv';
import {
  buildTemplateCsv,
  getTemplate,
  ImportType,
  isImportType,
  resolveMapping,
} from './import-templates';
import { buildTemplateWorkbook, readWorkbookRecords, XLSX_CONTENT_TYPE } from './import-workbook';
import {
  ImportRowResult,
  mapRecordValues,
  validateImportRows,
} from './import-validation';
import { CreateImportDto } from './dto/create-import.dto';
import { ListImportsDto } from './dto/list-imports.dto';

const MAX_ROWS = Number(process.env.IMPORT_MAX_ROWS ?? 2000);
const MAX_CONTENT_BYTES = Number(process.env.IMPORT_MAX_FILE_BYTES ?? 5_000_000);
const PREVIEW_LIMIT = 200;

export interface ImportJobSummary {
  fileErrors: string[];
  mapping: Record<string, string | null>;
  headers: string[];
  format?: 'csv' | 'xlsx';
}

export interface ImportTemplateFile {
  filename: string;
  contentType: string;
  /** CSV text, or base64 when `encoding` is `base64`. */
  content: string;
  encoding: 'text' | 'base64';
}

interface StoredRowData {
  values: Record<string, string>;
  normalized: Record<string, unknown>;
}

interface JobFields {
  id: string;
  type: string;
  filename: string;
  status: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  importedRows: number;
  failedRows: number;
  summary: unknown;
  createdAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  getTemplateCsv(rawType: string) {
    const type = this.assertType(rawType);
    return buildTemplateCsv(type);
  }

  /**
   * Downloads a template. Excel is the default because the brief asks for a
   * sample workbook; CSV stays available for spreadsheets that cannot open
   * .xlsx files.
   */
  async getTemplateFile(rawType: string, rawFormat?: string): Promise<ImportTemplateFile> {
    const type = this.assertType(rawType);
    const format = (rawFormat ?? 'xlsx').toLowerCase();

    if (format === 'csv') {
      return {
        filename: `${type.toLowerCase()}-import-template.csv`,
        contentType: 'text/csv;charset=utf-8',
        content: buildTemplateCsv(type),
        encoding: 'text',
      };
    }

    if (format !== 'xlsx') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Templates are available as xlsx or csv.',
      });
    }

    const workbook = await buildTemplateWorkbook(type);
    return {
      filename: `${type.toLowerCase()}-import-template.xlsx`,
      contentType: XLSX_CONTENT_TYPE,
      content: workbook.toString('base64'),
      encoding: 'base64',
    };
  }

  getSchema(rawType: string) {
    const type = this.assertType(rawType);
    const template = getTemplate(type);
    return {
      data: {
        type: template.type,
        label: template.label,
        summary: template.summary,
        instructions: template.instructions,
        fileTypes: [XLSX_CONTENT_TYPE, 'text/csv'],
        templateFormats: ['xlsx', 'csv'],
        maxRows: MAX_ROWS,
        columns: template.columns.map((column) => ({
          key: column.key,
          header: column.header,
          required: column.required,
          description: column.description,
          example: column.example,
        })),
      },
    };
  }

  async list(organizationId: string, query: ListImportsDto) {
    const jobs = await this.prisma.importJob.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 10,
    });

    return {
      data: jobs.map((job) => ({
        id: job.id,
        type: job.type,
        filename: job.filename,
        status: job.status,
        totalRows: job.totalRows,
        validRows: job.validRows,
        invalidRows: job.invalidRows,
        duplicateRows: job.duplicateRows,
        importedRows: job.importedRows,
        failedRows: job.failedRows,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      })),
    };
  }

  async validateAndStore(
    organizationId: string,
    actorId: string,
    branchId: string,
    dto: CreateImportDto,
  ) {
    const type = this.assertType(dto.type);

    if (/\.xls$/i.test(dto.filename)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message:
          'Legacy .xls files are not supported. Save the spreadsheet as .xlsx or CSV, then upload it again.',
      });
    }

    const isExcel = /\.xlsx$/i.test(dto.filename);
    if (!isExcel && !/\.csv$/i.test(dto.filename)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message:
          'Only .xlsx and .csv files are supported. Download the template, fill it in and upload it again.',
      });
    }

    const records = await this.readRecords(dto, isExcel);
    if (records.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'The uploaded file is empty.',
      });
    }

    const [headerRecord, ...dataRecords] = records;
    const headers = headerRecord.values.map((header) => header.trim());

    if (dataRecords.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'The file contains a header row but no data rows.',
      });
    }

    if (dataRecords.length > MAX_ROWS) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `The file contains ${dataRecords.length} rows. The maximum per import is ${MAX_ROWS}.`,
      });
    }

    const { mapping, missingRequired } = resolveMapping(type, headers, dto.mapping);
    const summary: ImportJobSummary = {
      fileErrors: missingRequired.length
        ? [
            `Missing required column(s): ${missingRequired.join(', ')}. Map each required column to a header in your file.`,
          ]
        : [],
      mapping,
      headers,
      format: isExcel ? 'xlsx' : 'csv',
    };

    if (missingRequired.length > 0) {
      const failedJob = await this.prisma.importJob.create({
        data: {
          organizationId,
          branchId,
          type,
          filename: dto.filename,
          status: 'FAILED',
          totalRows: 0,
          createdById: actorId,
          summary: summary as never,
        },
      });
      return this.detail(failedJob, []);
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';

    const products = await this.prisma.product.findMany({
      where: { organizationId },
      select: { id: true, name: true, unit: true, normalizedName: true, barcode: true },
    });

    const productIndex = new Map(
      products.map((product) => [
        product.normalizedName,
        { id: product.id, name: product.name, unit: product.unit },
      ]),
    );
    const barcodeIndex = new Map<string, string>();
    for (const product of products) {
      if (product.barcode) barcodeIndex.set(product.barcode, product.name);
    }

    const rowInputs = dataRecords.map((record) => ({
      rowNumber: record.line,
      values: mapRecordValues(type, headers, record.values, mapping),
    }));

    const results = validateImportRows(type, rowInputs, {
      products: productIndex,
      barcodes: barcodeIndex,
      todayKey: localDateKey(new Date(), timeZone),
    });

    const counts = this.countRows(results);

    const job = await this.prisma.importJob.create({
      data: {
        organizationId,
        branchId,
        type,
        filename: dto.filename,
        status: 'VALIDATED',
        totalRows: results.length,
        validRows: counts.valid,
        invalidRows: counts.invalid,
        duplicateRows: counts.duplicate,
        createdById: actorId,
        summary: summary as never,
        rows: {
          create: results.map((result) => ({
            rowNumber: result.rowNumber,
            status: result.status,
            data: {
              values: result.values,
              normalized: result.normalized,
            } as never,
            errors: result.errors as never,
          })),
        },
      },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'IMPORT_VALIDATED',
      entityType: 'ImportJob',
      entityId: job.id,
      metadata: {
        type,
        filename: dto.filename,
        totalRows: results.length,
        validRows: counts.valid,
        invalidRows: counts.invalid,
        duplicateRows: counts.duplicate,
      },
    });

    return this.detail(job, results);
  }

  async findOne(organizationId: string, id: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, organizationId } });
    if (!job) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Import job not found' });
    }

    const rows = await this.prisma.importJobRow.findMany({
      where: { jobId: id },
      orderBy: { rowNumber: 'asc' },
      take: PREVIEW_LIMIT,
    });

    return {
      data: {
        ...this.jobRecord(job),
        summary: job.summary as unknown as ImportJobSummary,
        previewLimit: PREVIEW_LIMIT,
        rows: rows.map((row) => this.rowRecord(row)),
      },
    };
  }

  async confirm(organizationId: string, actorId: string, branchId: string, id: string) {
    const job = await this.prisma.importJob.findFirst({
      where: { id, organizationId },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!job) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Import job not found' });
    }
    if (job.status !== 'VALIDATED') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'This import has already been processed.',
      });
    }
    if (job.validRows === 0) {
      throw new BadRequestException({
        code: 'IMPORT_ROW_ERRORS',
        message: 'There are no valid rows to import. Correct the file and upload it again.',
      });
    }

    const type = job.type as ImportType;
    let imported = 0;
    let failed = 0;

    for (const row of job.rows) {
      if (row.status !== 'VALID') continue;

      const stored = row.data as unknown as StoredRowData;
      try {
        const entity = await this.importRow(
          organizationId,
          job.branchId ?? branchId,
          job.id,
          type,
          row.rowNumber,
          stored.normalized,
        );
        imported += 1;
        await this.prisma.importJobRow.update({
          where: { id: row.id },
          data: {
            status: 'IMPORTED',
            productId: entity.productId ?? null,
            batchId: entity.batchId ?? null,
          },
        });
      } catch (error) {
        failed += 1;
        const message = this.describeError(error);
        await this.prisma.importJobRow.update({
          where: { id: row.id },
          data: {
            status: 'FAILED',
            errors: [...this.rowErrors(row.errors), message] as never,
          },
        });
      }
    }

    const status = failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    const updated = await this.prisma.importJob.update({
      where: { id: job.id },
      data: {
        status,
        importedRows: imported,
        failedRows: failed,
        completedAt: new Date(),
      },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'IMPORT_CONFIRMED',
      entityType: 'ImportJob',
      entityId: job.id,
      metadata: {
        type,
        filename: job.filename,
        importedRows: imported,
        failedRows: failed,
      },
    });

    const rows = await this.prisma.importJobRow.findMany({
      where: { jobId: job.id },
      orderBy: { rowNumber: 'asc' },
      take: PREVIEW_LIMIT,
    });

    return {
      data: {
        ...this.jobRecord(updated),
        summary: updated.summary as unknown as ImportJobSummary,
        previewLimit: PREVIEW_LIMIT,
        rows: rows.map((row) => this.rowRecord(row)),
      },
    };
  }

  async errorReportCsv(organizationId: string, id: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, organizationId } });
    if (!job) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Import job not found' });
    }

    const rows = await this.prisma.importJobRow.findMany({
      where: { jobId: id, status: { in: ['INVALID', 'DUPLICATE', 'FAILED'] } },
      orderBy: { rowNumber: 'asc' },
    });

    const template = getTemplate(job.type as ImportType);
    const header = ['Row', 'Status', 'Errors', ...template.columns.map((column) => column.header)];
    const body = rows.map((row) => {
      const stored = row.data as unknown as StoredRowData;
      return [
        String(row.rowNumber),
        row.status,
        this.rowErrors(row.errors).join(' | '),
        ...template.columns.map((column) => stored.values?.[column.key] ?? ''),
      ];
    });

    return toCsv([header, ...body]);
  }

  /**
   * Turns the uploaded payload into parser records. CSV arrives as text while
   * Excel arrives base64 encoded, because the API only accepts JSON bodies.
   */
  private async readRecords(dto: CreateImportDto, isExcel: boolean): Promise<CsvRecord[]> {
    const encoding = dto.encoding ?? (isExcel ? 'base64' : 'text');

    if (isExcel) {
      if (encoding !== 'base64') {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Excel files must be uploaded with encoding "base64".',
        });
      }

      const buffer = Buffer.from(dto.content, 'base64');
      if (buffer.length === 0) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'The uploaded workbook is empty or could not be decoded.',
        });
      }
      this.assertFileSize(buffer.length);

      try {
        return await readWorkbookRecords(buffer);
      } catch {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'The workbook could not be read. Save it as .xlsx or CSV and upload it again.',
        });
      }
    }

    const content =
      encoding === 'base64' ? Buffer.from(dto.content, 'base64').toString('utf8') : dto.content;
    this.assertFileSize(Buffer.byteLength(content, 'utf8'));
    return parseCsv(content);
  }

  private assertFileSize(bytes: number): void {
    if (bytes > MAX_CONTENT_BYTES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `The file is larger than ${Math.round(MAX_CONTENT_BYTES / 1_000_000)}MB. Split it into smaller files.`,
      });
    }
  }

  private async importRow(
    organizationId: string,
    branchId: string,
    jobId: string,
    type: ImportType,
    rowNumber: number,
    normalized: Record<string, unknown>,
  ): Promise<{ productId?: string; batchId?: string }> {
    if (type === 'PRODUCTS') {
      const name = String(normalized.name ?? '');
      const normalizedName = String(normalized.normalizedName ?? normalizeProductName(name));

      const existing = await this.prisma.product.findFirst({
        where: { organizationId, normalizedName },
        select: { id: true },
      });
      if (existing) {
        throw new BadRequestException(`Product "${name}" already exists in the catalogue.`);
      }

      const barcode = (normalized.barcode as string | null) ?? null;
      if (barcode) {
        const owner = await this.prisma.product.findFirst({
          where: { organizationId, barcode },
          select: { name: true },
        });
        if (owner) {
          throw new BadRequestException(`Barcode ${barcode} is already assigned to ${owner.name}.`);
        }
      }

      const product = await this.prisma.product.create({
        data: {
          organizationId,
          name,
          normalizedName,
          brand: (normalized.brand as string | null) ?? null,
          strength: (normalized.strength as string | null) ?? null,
          dosageForm: (normalized.dosageForm as string | null) ?? null,
          packSize: (normalized.packSize as string | null) ?? null,
          unit: String(normalized.unit ?? 'unit'),
          barcode,
          reorderThreshold: (normalized.reorderThreshold as number | null) ?? null,
          active: normalized.active !== false,
        },
        select: { id: true },
      });

      return { productId: product.id };
    }

    const productId = normalized.productId as string | null;
    const product = productId
      ? await this.prisma.product.findFirst({
          where: { id: productId, organizationId },
          select: { id: true, unit: true },
        })
      : null;
    if (!product) {
      throw new BadRequestException('Product was not found in the catalogue.');
    }

    const quantity = Number(normalized.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be greater than zero.');
    }

    const expiryDate = normalized.expiryDate ? new Date(String(normalized.expiryDate)) : null;

    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.create({
        data: {
          organizationId,
          branchId,
          productId: product.id,
          batchNumber: (normalized.batchNumber as string | null) ?? null,
          expiryDate,
          unit: String(normalized.unit ?? product.unit),
          unitCost: (normalized.unitCost as number | null) ?? null,
          sellingPrice: (normalized.sellingPrice as number | null) ?? null,
        },
        select: { id: true },
      });

      await tx.stockMovement.create({
        data: {
          organizationId,
          branchId,
          batchId: batch.id,
          type: 'OPENING',
          quantityDelta: quantity,
          reason: 'Bulk import opening stock',
          actorId: null,
          idempotencyKey: `import-${jobId}-${rowNumber}`,
        },
      });

      await tx.batchBalance.upsert({
        where: { batchId: batch.id },
        create: {
          organizationId,
          batchId: batch.id,
          quantity,
          version: 1,
        },
        update: {
          quantity,
          version: { increment: 1 },
        },
      });

      return { productId: product.id, batchId: batch.id };
    });
  }

  private detail(job: JobFields, results: ImportRowResult[]) {
    return {
      data: {
        ...this.jobRecord(job),
        summary: job.summary as ImportJobSummary,
        previewLimit: PREVIEW_LIMIT,
        rows: results.map((result) => ({
          rowNumber: result.rowNumber,
          status: result.status,
          errors: result.errors,
          values: result.values,
        })),
      },
    };
  }

  private jobRecord(job: JobFields) {
    return {
      id: job.id,
      type: job.type,
      filename: job.filename,
      status: job.status,
      totalRows: job.totalRows,
      validRows: job.validRows,
      invalidRows: job.invalidRows,
      duplicateRows: job.duplicateRows,
      importedRows: job.importedRows,
      failedRows: job.failedRows,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  private rowRecord(row: {
    rowNumber: number;
    status: string;
    data: unknown;
    errors: unknown;
    productId?: string | null;
    batchId?: string | null;
  }) {
    const stored = row.data as StoredRowData;
    return {
      rowNumber: row.rowNumber,
      status: row.status,
      errors: this.rowErrors(row.errors),
      values: stored?.values ?? {},
      productId: row.productId ?? null,
      batchId: row.batchId ?? null,
    };
  }

  private rowErrors(errors: unknown): string[] {
    return Array.isArray(errors) ? errors.map((error) => String(error)) : [];
  }

  private countRows(results: ImportRowResult[]) {
    return {
      valid: results.filter((result) => result.status === 'VALID').length,
      invalid: results.filter((result) => result.status === 'INVALID').length,
      duplicate: results.filter((result) => result.status === 'DUPLICATE').length,
    };
  }

  private assertType(value: string): ImportType {
    if (!isImportType(value)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Unsupported import type. Supported types: ${['PRODUCTS', 'BATCHES', 'INITIAL_STOCK'].join(', ')}.`,
      });
    }
    return value;
  }

  private describeError(error: unknown): string {
    if (error && typeof error === 'object') {
      const response = (error as { response?: { message?: string } }).response;
      if (response?.message) return String(response.message);
      const message = (error as { message?: string }).message;
      if (message) return message;
    }
    return 'This row could not be imported.';
  }
}
