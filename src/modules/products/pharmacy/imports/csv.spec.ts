import { normalizeHeader, parseCsv, toCsv } from './csv';

describe('parseCsv', () => {
  it('parses quoted fields containing commas, quotes and newlines', () => {
    const content = 'name,note\r\n"Paracetamol, 500mg","Take ""as directed"""\r\n"Multi\nline",ok\r\n';
    const records = parseCsv(content);

    expect(records).toHaveLength(3);
    expect(records[0].values).toEqual(['name', 'note']);
    expect(records[1].values).toEqual(['Paracetamol, 500mg', 'Take "as directed"']);
    expect(records[2].values).toEqual(['Multi\nline', 'ok']);
    expect(records[1].line).toBe(2);
    expect(records[2].line).toBe(3);
  });

  it('skips template instruction lines, blank lines and a BOM', () => {
    const content = '\uFEFF# Product import template\n# Required: Product name\n\nProduct name,Unit\nParacetamol,tablet\n';
    const records = parseCsv(content);

    expect(records).toHaveLength(2);
    expect(records[0].values).toEqual(['Product name', 'Unit']);
    expect(records[1].values).toEqual(['Paracetamol', 'tablet']);
  });

  it('keeps trailing empty cells', () => {
    const records = parseCsv('a,b,c\n1,,\n');
    expect(records[1].values).toEqual(['1', '', '']);
  });
});

describe('toCsv', () => {
  it('quotes cells that contain separators', () => {
    const csv = toCsv([
      ['name', 'errors'],
      ['Paracetamol, 500mg', 'Row is invalid | "Missing unit"'],
    ]);

    expect(csv).toContain('"Paracetamol, 500mg"');
    expect(csv).toContain('"Row is invalid | ""Missing unit"""');
  });
});

describe('normalizeHeader', () => {
  it('normalises human readable headers', () => {
    expect(normalizeHeader('Product name')).toBe('product_name');
    expect(normalizeHeader('PRODUCT-NAME')).toBe('product_name');
    expect(normalizeHeader('  Reorder threshold ')).toBe('reorder_threshold');
  });
});
