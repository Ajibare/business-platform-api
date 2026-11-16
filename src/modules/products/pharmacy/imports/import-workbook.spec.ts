import * as ExcelJS from 'exceljs';
import { ImportType, getTemplate } from './import-templates';
import { buildTemplateWorkbook, readWorkbookRecords } from './import-workbook';

describe('buildTemplateWorkbook', () => {
  const types: ImportType[] = ['PRODUCTS', 'BATCHES', 'INITIAL_STOCK'];

  it.each(types)('builds a real xlsx file for %s', async (type) => {
    const buffer = await buildTemplateWorkbook(type);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);
    // Every .xlsx file is a zip container.
    expect(buffer.subarray(0, 2).toString('utf8')).toBe('PK');
  });

  it.each(types)('separates guidance from data for %s', async (type) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildTemplateWorkbook(type)) as unknown as ArrayBuffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Instructions', 'Template']);
  });

  it('writes the exact headers the validator maps against', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildTemplateWorkbook('PRODUCTS')) as unknown as ArrayBuffer);

    const sheet = workbook.getWorksheet('Template')!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell) => headers.push(String(cell.value)));

    expect(headers).toEqual(getTemplate('PRODUCTS').columns.map((column) => column.header));
    // The header row carries a filter so the sheet behaves like a table.
    expect(sheet.autoFilter).toBeDefined();
  });

  it('includes the guidance sheet with a column reference and data conventions', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildTemplateWorkbook('PRODUCTS')) as unknown as ArrayBuffer);

    const lines: string[] = [];
    workbook.getWorksheet('Instructions')!.eachRow((row) => {
      lines.push(row.getCell(1).value === null ? '' : String(row.getCell(1).value));
    });
    const text = lines.join('\n');

    expect(text).toContain('How to use this file');
    expect(text).toContain('Data conventions');
    expect(text).toContain('Common upload errors');
    expect(text).toContain('Product name');
  });
});

describe('readWorkbookRecords', () => {
  it('reads the data sheet of a downloaded template, not the instructions sheet', async () => {
    const template = getTemplate('PRODUCTS');
    const records = await readWorkbookRecords(await buildTemplateWorkbook('PRODUCTS'));

    // Trailing blank cells are never returned, so compare against the sample without them.
    const expectedSample = [...template.samples[0]];
    while (expectedSample.length > 0 && expectedSample[expectedSample.length - 1] === '') {
      expectedSample.pop();
    }

    expect(records).toHaveLength(1 + template.samples.length);
    expect(records[0].line).toBe(1);
    expect(records[0].values).toEqual(template.columns.map((column) => column.header));
    expect(records[1].values).toEqual(expectedSample);
  });

  it('reads a hand-filled sheet, honouring dates and skipping blank rows', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Product name', 'Unit', 'Batch number', 'Expiry date', 'Quantity']);
    sheet.addRow(['Paracetamol 500mg', 'tablet', 'PC2451', new Date('2027-02-14T00:00:00.000Z'), 240]);
    sheet.addRow([]);
    sheet.addRow(['Amoxicillin 250mg', 'capsule', 'AM1170', new Date('2026-12-01T00:00:00.000Z'), 60]);

    const data = await workbook.xlsx.writeBuffer();
    const records = await readWorkbookRecords(
      Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer),
    );

    // The empty third row is skipped, and row numbers still match the spreadsheet.
    expect(records.map((record) => record.line)).toEqual([1, 2, 4]);
    expect(records[2].values).toEqual(['Amoxicillin 250mg', 'capsule', 'AM1170', '2026-12-01', '60']);
  });

  it('drops trailing empty columns so mapping does not depend on padding', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Product name', 'Unit', 'Brand', 'Strength']);
    sheet.addRow(['Paracetamol 500mg', 'tablet', null, null]);

    const data = await workbook.xlsx.writeBuffer();
    const records = await readWorkbookRecords(
      Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer),
    );

    expect(records[1].values).toEqual(['Paracetamol 500mg', 'tablet']);
  });

  it('rejects a file that is not a workbook so the caller can report it', async () => {
    await expect(readWorkbookRecords(Buffer.from('Product name,Unit\nParacetamol,tablet'))).rejects.toThrow();
  });

  it('returns nothing for an empty workbook instead of throwing', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1');
    const data = await workbook.xlsx.writeBuffer();

    const records = await readWorkbookRecords(
      Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer),
    );

    expect(records).toEqual([]);
  });
});
