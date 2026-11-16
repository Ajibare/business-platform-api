import {
  mapRecordValues,
  parseImportDate,
  parseImportQuantity,
  validateImportRows,
} from './import-validation';
import { resolveMapping } from './import-templates';

const context = {
  products: new Map([
    ['paracetamol-500mg-tablet', { id: 'product-1', name: 'Paracetamol 500mg Tablet', unit: 'tablet' }],
  ]),
  barcodes: new Map([['6151100010203', 'Existing Product']]),
  todayKey: '2026-11-16',
};

describe('parseImportDate', () => {
  it('accepts the documented formats', () => {
    expect(parseImportDate('2027-04-30')?.toISOString()).toBe('2027-04-30T00:00:00.000Z');
    expect(parseImportDate('30/04/2027')?.toISOString()).toBe('2027-04-30T00:00:00.000Z');
    expect(parseImportDate('30-04-2027')?.toISOString()).toBe('2027-04-30T00:00:00.000Z');
  });

  it('rejects impossible dates', () => {
    expect(parseImportDate('2027-02-30')).toBeNull();
    expect(parseImportDate('next month')).toBeNull();
  });
});

describe('parseImportQuantity', () => {
  it('accepts thousand separators and decimals', () => {
    expect(parseImportQuantity('1,200.5')).toBe(1200.5);
    expect(parseImportQuantity('')).toBeNull();
    expect(parseImportQuantity('ten')).toBeNull();
  });
});

describe('resolveMapping', () => {
  it('matches aliases case-insensitively', () => {
    const { mapping, missingRequired } = resolveMapping('PRODUCTS', [
      'Product Name',
      'UNIT',
      'Barcode',
    ]);

    expect(mapping.product_name).toBe('Product Name');
    expect(mapping.unit).toBe('UNIT');
    expect(mapping.barcode).toBe('Barcode');
    expect(missingRequired).toEqual([]);
  });

  it('reports missing required columns', () => {
    const { missingRequired } = resolveMapping('BATCHES', ['Product name', 'Quantity']);
    expect(missingRequired).toEqual(['Batch number', 'Expiry date']);
  });

  it('honours explicit column overrides', () => {
    const { mapping } = resolveMapping(
      'PRODUCTS',
      ['Item description', 'UOM'],
      { product_name: 'Item description', unit: 'UOM' },
    );

    expect(mapping.product_name).toBe('Item description');
    expect(mapping.unit).toBe('UOM');
  });
});

describe('mapRecordValues', () => {
  it('maps header positions to template keys', () => {
    const values = mapRecordValues(
      'PRODUCTS',
      ['Unit', 'Product name'],
      ['tablet', 'Paracetamol'],
      { product_name: 'Product name', unit: 'Unit' },
    );

    expect(values.product_name).toBe('Paracetamol');
    expect(values.unit).toBe('tablet');
    expect(values.brand).toBe('');
  });
});

describe('validateImportRows for products', () => {
  it('flags products that already exist in the catalogue', () => {
    const [row] = validateImportRows(
      'PRODUCTS',
      [
        {
          rowNumber: 2,
          values: { product_name: 'Paracetamol 500mg Tablet', unit: 'tablet' },
        },
      ],
      context,
    );

    expect(row.status).toBe('DUPLICATE');
    expect(row.errors.join(' ')).toContain('already exists');
  });

  it('flags duplicate barcodes and missing units', () => {
    const rows = validateImportRows(
      'PRODUCTS',
      [
        { rowNumber: 2, values: { product_name: 'New Drug', unit: '', barcode: '6151100010203' } },
      ],
      context,
    );

    expect(rows[0].status).toBe('DUPLICATE');
    expect(rows[0].errors).toEqual(
      expect.arrayContaining([
        'Unit is required.',
        expect.stringContaining('already assigned to Existing Product'),
      ]),
    );
  });

  it('accepts a valid product row and normalises the barcode', () => {
    const [row] = validateImportRows(
      'PRODUCTS',
      [
        {
          rowNumber: 2,
          values: {
            product_name: 'Ibuprofen 200mg Tablet',
            unit: 'tablet',
            barcode: ' 6151100099999 ',
            reorder_threshold: '20',
            active: 'TRUE',
          },
        },
      ],
      context,
    );

    expect(row.status).toBe('VALID');
    expect(row.normalized.barcode).toBe('6151100099999');
    expect(row.normalized.reorderThreshold).toBe(20);
    expect(row.normalized.active).toBe(true);
  });
});

describe('validateImportRows for batches', () => {
  const baseRow = {
    product_name: 'Paracetamol 500mg Tablet',
    batch_number: 'PC-1',
    expiry_date: '2027-04-30',
    quantity: '100',
    unit_cost: '18.5',
    selling_price: '25',
  };

  it('rejects products that are not in the catalogue', () => {
    const [row] = validateImportRows(
      'BATCHES',
      [{ rowNumber: 2, values: { ...baseRow, product_name: 'Unknown Drug' } }],
      context,
    );

    expect(row.status).toBe('INVALID');
    expect(row.errors.join(' ')).toContain('was not found in the catalogue');
  });

  it('rejects expired, zero quantity and missing batch numbers', () => {
    const [expired] = validateImportRows(
      'BATCHES',
      [{ rowNumber: 2, values: { ...baseRow, expiry_date: '2026-01-01' } }],
      context,
    );
    const [zero] = validateImportRows(
      'BATCHES',
      [{ rowNumber: 2, values: { ...baseRow, quantity: '0' } }],
      context,
    );
    const [noBatch] = validateImportRows(
      'BATCHES',
      [{ rowNumber: 2, values: { ...baseRow, batch_number: '' } }],
      context,
    );

    expect(expired.errors.join(' ')).toContain('in the past');
    expect(zero.errors.join(' ')).toContain('greater than zero');
    expect(noBatch.errors.join(' ')).toContain('Batch number is required');
  });

  it('flags repeated batches inside the same file', () => {
    const rows = validateImportRows(
      'BATCHES',
      [
        { rowNumber: 2, values: baseRow },
        { rowNumber: 3, values: baseRow },
      ],
      context,
    );

    expect(rows[0].status).toBe('VALID');
    expect(rows[1].status).toBe('DUPLICATE');
    expect(rows[1].errors.join(' ')).toContain('row 2');
  });

  it('resolves the catalogue product for valid rows', () => {
    const [row] = validateImportRows('BATCHES', [{ rowNumber: 2, values: baseRow }], context);
    expect(row.status).toBe('VALID');
    expect(row.normalized.productId).toBe('product-1');
    expect(row.normalized.quantity).toBe(100);
    expect(row.normalized.unitCost).toBe(18.5);
  });
});
