import { dateKeyFromCalendarDate, diffDaysKeys } from '../../../../common/utils/time';
import { normalizeProductName } from '../../../../common/utils/product-name';
import { isValidBarcode, normalizeBarcode } from '../barcodes/barcode.util';
import { getTemplate, ImportType } from './import-templates';
import { normalizeHeader } from './csv';

export type ImportRowStatus = 'VALID' | 'INVALID' | 'DUPLICATE';

export interface ImportRowInput {
  rowNumber: number;
  values: Record<string, string>;
}

export interface ImportValidationContext {
  /** Normalised product name -> catalogue product. */
  products: Map<string, { id: string; name: string; unit: string }>;
  /** Normalised barcode -> product name already using it. */
  barcodes: Map<string, string>;
  /** Workspace-local date key, used to reject past expiry dates. */
  todayKey: string;
}

export interface ImportRowResult {
  rowNumber: number;
  status: ImportRowStatus;
  values: Record<string, string>;
  errors: string[];
  normalized: Record<string, unknown>;
}

const DATE_PATTERNS: Array<{ pattern: RegExp; parse: (match: RegExpMatchArray) => [number, number, number] }> = [
  {
    pattern: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
    parse: (match) => [Number(match[1]), Number(match[2]), Number(match[3])],
  },
  {
    pattern: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/,
    parse: (match) => [Number(match[3]), Number(match[2]), Number(match[1])],
  },
];

export function parseImportDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  for (const { pattern, parse } of DATE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const [year, month, day] = parse(match);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }

  return null;
}

export function parseImportQuantity(value: string): number | null {
  const trimmed = value.replace(/,/g, '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseMoney(value: string): number | null | undefined {
  const trimmed = value.replace(/[₦,\s]/g, '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parseBoolean(value: string): boolean | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (['true', 'yes', 'y', '1', 'active'].includes(trimmed)) return true;
  if (['false', 'no', 'n', '0', 'inactive'].includes(trimmed)) return false;
  return null;
}

function expiryKey(date: Date): string {
  return dateKeyFromCalendarDate(date);
}

/**
 * Validates mapped rows for an import type. Validation is pure so the same rules
 * are applied during preview and again before confirmation.
 */
export function validateImportRows(
  type: ImportType,
  rows: ImportRowInput[],
  context: ImportValidationContext,
): ImportRowResult[] {
  const seenProducts = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
  const seenBatches = new Map<string, number>();
  const results: ImportRowResult[] = [];

  for (const row of rows) {
    const errors: string[] = [];
    const values = row.values;

    if (type === 'PRODUCTS') {
      const name = values.product_name?.trim() ?? '';
      const normalizedName = normalizeProductName(name);
      if (!name) errors.push('Product name is required.');
      if (!values.unit?.trim()) errors.push('Unit is required.');

      if (normalizedName) {
        const firstRow = seenProducts.get(normalizedName);
        if (firstRow) {
          results.push(
            duplicate(row, errors, `Product "${name}" already appears on row ${firstRow} of this file.`),
          );
          continue;
        }
        seenProducts.set(normalizedName, row.rowNumber);
        if (context.products.has(normalizedName)) {
          results.push(
            duplicate(row, errors, `Product "${name}" already exists in the catalogue.`),
          );
          continue;
        }
      }

      const barcodeValue = values.barcode?.trim() ?? '';
      let barcode: string | null = null;
      if (barcodeValue) {
        barcode = normalizeBarcode(barcodeValue);
        if (!isValidBarcode(barcode)) {
          errors.push(
            'Barcode must be 4 to 64 characters using letters, numbers, dot, dash or underscore.',
          );
        } else {
          const firstRow = seenBarcodes.get(barcode);
          if (firstRow) {
            results.push(
              duplicate(row, errors, `Barcode ${barcode} already appears on row ${firstRow} of this file.`),
            );
            continue;
          }
          seenBarcodes.set(barcode, row.rowNumber);
          const owner = context.barcodes.get(barcode);
          if (owner) {
            results.push(
              duplicate(row, errors, `Barcode ${barcode} is already assigned to ${owner}.`),
            );
            continue;
          }
        }
      }

      let reorderThreshold: number | null = null;
      if (values.reorder_threshold?.trim()) {
        const parsed = parseImportQuantity(values.reorder_threshold);
        if (parsed === null || parsed < 0) {
          errors.push('Reorder threshold must be zero or a positive number.');
        } else {
          reorderThreshold = parsed;
        }
      }

      let active = true;
      if (values.active?.trim()) {
        const parsed = parseBoolean(values.active);
        if (parsed === null) {
          errors.push('Active must be TRUE or FALSE.');
        } else {
          active = parsed;
        }
      }

      results.push({
        rowNumber: row.rowNumber,
        status: errors.length ? 'INVALID' : 'VALID',
        values,
        errors,
        normalized: {
          name,
          normalizedName,
          brand: values.brand?.trim() || null,
          strength: values.strength?.trim() || null,
          dosageForm: values.dosage_form?.trim() || null,
          packSize: values.pack_size?.trim() || null,
          unit: values.unit?.trim() || '',
          barcode,
          reorderThreshold,
          active,
        },
      });
      continue;
    }

    // BATCHES and INITIAL_STOCK both create a batch plus an opening movement.
    const requiresBatchNumber = type === 'BATCHES';
    const requiresExpiry = type === 'BATCHES';

    const productName = values.product_name?.trim() ?? '';
    const normalizedName = normalizeProductName(productName);
    const product = normalizedName ? context.products.get(normalizedName) : undefined;
    if (!productName) {
      errors.push('Product name is required.');
    } else if (!product) {
      errors.push(
        `Product "${productName}" was not found in the catalogue. Import the product catalogue first.`,
      );
    }

    const batchNumber = values.batch_number?.trim() || null;
    if (requiresBatchNumber && !batchNumber) {
      errors.push('Batch number is required for batch imports.');
    }

    const expiryValue = values.expiry_date?.trim() ?? '';
    let expiryDate: Date | null = null;
    if (!expiryValue) {
      if (requiresExpiry) errors.push('Expiry date is required for batch imports.');
    } else {
      expiryDate = parseImportDate(expiryValue);
      if (!expiryDate) {
        errors.push('Expiry date must use YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY.');
      } else if (diffDaysKeys(context.todayKey, expiryKey(expiryDate)) < 0) {
        errors.push('Expiry date is in the past. Record expired stock through a stock movement.');
        expiryDate = null;
      }
    }

    const quantity = parseImportQuantity(values.quantity ?? '');
    if (quantity === null) {
      errors.push('Quantity is required and must be a number.');
    } else if (quantity <= 0) {
      errors.push('Quantity must be greater than zero.');
    }

    const unitCost = parseMoney(values.unit_cost ?? '');
    if (unitCost === undefined) errors.push('Unit cost must be zero or a positive number.');
    const sellingPrice = parseMoney(values.selling_price ?? '');
    if (sellingPrice === undefined) {
      errors.push('Selling price must be zero or a positive number.');
    }

    if (product && quantity !== null && quantity > 0) {
      const duplicateKey = [
        normalizedName,
        (batchNumber ?? '').toUpperCase(),
        expiryDate ? expiryKey(expiryDate) : '',
      ].join('|');
      const firstRow = seenBatches.get(duplicateKey);
      if (firstRow) {
        results.push(
          duplicate(
            row,
            errors,
            `This batch already appears on row ${firstRow} of this file.`,
          ),
        );
        continue;
      }
      seenBatches.set(duplicateKey, row.rowNumber);
    }

    results.push({
      rowNumber: row.rowNumber,
      status: errors.length ? 'INVALID' : 'VALID',
      values,
      errors,
      normalized: {
        productId: product?.id ?? null,
        productName,
        normalizedName,
        unit: values.unit?.trim() || product?.unit || 'unit',
        batchNumber,
        expiryDate: expiryDate ? expiryDate.toISOString() : null,
        quantity,
        unitCost: unitCost ?? null,
        sellingPrice: sellingPrice ?? null,
      },
    });
  }

  return results;
}

function duplicate(row: ImportRowInput, errors: string[], message: string): ImportRowResult {
  return {
    rowNumber: row.rowNumber,
    status: 'DUPLICATE',
    values: row.values,
    errors: [...errors, message],
    normalized: {},
  };
}

/** Maps a record to template column keys using a resolved header mapping. */
export function mapRecordValues(
  type: ImportType,
  headers: string[],
  values: string[],
  mapping: Record<string, string | null>,
): Record<string, string> {
  const headerPositions = new Map<string, number>();
  headers.forEach((header, index) => headerPositions.set(normalizeHeader(header), index));

  const mapped: Record<string, string> = {};
  for (const column of getTemplate(type).columns) {
    const header = mapping[column.key];
    if (!header) {
      mapped[column.key] = '';
      continue;
    }
    const position = headerPositions.get(normalizeHeader(header));
    mapped[column.key] = position === undefined ? '' : (values[position] ?? '').trim();
  }
  return mapped;
}
