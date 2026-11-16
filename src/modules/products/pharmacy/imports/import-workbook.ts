import * as ExcelJS from 'exceljs';
import { CsvRecord } from './csv';
import { getTemplate, ImportTemplate, ImportType } from './import-templates';

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const HEADER_FILL = 'FFE8EEF7';
const HEADER_TEXT = 'FF1F2937';
const SAMPLE_FILL = 'FFF7F9FC';
const TEXT_COLUMNS = new Set(['expiry_date', 'barcode', 'batch_number']);

/** Converts an ExcelJS cell value to the string the validator expects. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDateKey(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((part) => part.text)
        .join('')
        .trim();
    }
  }
  return String(value).trim();
}

function formatDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function widthFor(header: string, samples: string[]): number {
  const longest = Math.max(header.length, ...samples.map((sample) => sample.length));
  return Math.min(Math.max(longest + 4, 14), 46);
}

function addInstructionsSheet(workbook: ExcelJS.Workbook, template: ImportTemplate): void {
  const sheet = workbook.addWorksheet('Instructions', {
    properties: { defaultColWidth: 32 },
  });
  sheet.columns = [
    { key: 'a', width: 26 },
    { key: 'b', width: 34 },
    { key: 'c', width: 16 },
    { key: 'd', width: 52 },
    { key: 'e', width: 26 },
  ];

  const title = sheet.addRow([`${template.label} import template`]);
  title.font = { bold: true, size: 14, color: { argb: HEADER_TEXT } };

  sheet.addRow([template.summary]).getCell(1).font = { italic: true };
  sheet.addRow([]);

  const steps = sheet.addRow(['How to use this file']).getCell(1);
  steps.font = { bold: true };

  const guide = [
    '1. Open the "Template" sheet and delete the two sample rows.',
    '2. Fill one row per record. Do not rename, reorder or delete the header row.',
    '3. Save the workbook, then upload it on the pharmacy import page.',
    '4. Review the preview. Only valid rows are imported, and every error is listed by row.',
    '5. Download the error report when rows are rejected, fix them and upload again.',
    ...template.instructions.map((instruction, index) => `${index + 6}. ${instruction}`),
  ];
  for (const line of guide) {
    sheet.addRow([line]);
  }

  sheet.addRow([]);
  const conventions = sheet.addRow(['Data conventions']).getCell(1);
  conventions.font = { bold: true };
  for (const line of [
    'Dates: use DD/MM/YYYY or YYYY-MM-DD. Excel date cells are read correctly.',
    'Quantities and prices: numbers only, no currency symbols, spaces or thousands separators.',
    'Batch numbers: one row per batch. Repeat the product name to add the same medicine in several batches.',
    'Text values are trimmed. Blank optional cells are treated as not supplied.',
  ]) {
    sheet.addRow([line]);
  }

  sheet.addRow([]);
  const referenceHeader = sheet.addRow(['Column', 'Required', 'Example', 'Description']);
  referenceHeader.font = { bold: true, color: { argb: HEADER_TEXT } };
  referenceHeader.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });

  for (const column of template.columns) {
    sheet.addRow([column.header, column.required ? 'Yes' : 'No', column.example, column.description]);
  }

  sheet.addRow([]);
  const errors = sheet.addRow(['Common upload errors']).getCell(1);
  errors.font = { bold: true };
  for (const line of [
    'A required column header was changed, so the column could not be matched.',
    'The same product appears twice in the catalogue sheet (product names must be unique).',
    'A batch or stock row references a product that is not in the catalogue yet.',
    'The expiry date is in the past, or the quantity is zero or negative.',
    'The file was saved as .xls. Save it as .xlsx or CSV instead.',
  ]) {
    sheet.addRow([line]);
  }
}

function addTemplateSheet(workbook: ExcelJS.Workbook, template: ImportTemplate): void {
  const headers = template.columns.map((column) => column.header);
  const sheet = workbook.addWorksheet('Template', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = template.columns.map((column, index) => ({
    header: column.header,
    key: column.key,
    width: widthFor(column.header, template.samples.map((sample) => sample[index] ?? '')),
  }));

  const headerRow = sheet.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  template.samples.forEach((sample, index) => {
    const row = sheet.getRow(index + 2);
    template.columns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      const raw = sample[columnIndex] ?? '';
      cell.value = raw;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAMPLE_FILL } };
      if (TEXT_COLUMNS.has(column.key) && raw !== '') {
        cell.numFmt = '@';
      }
    });
    row.commit();
  });
}

/**
 * Builds the downloadable workbook: a guidance sheet plus a data sheet whose
 * header row is exactly what the validator maps against.
 */
export async function buildTemplateWorkbook(type: ImportType): Promise<Buffer> {
  const template = getTemplate(type);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Pharmacy stock intelligence';
  workbook.created = new Date();

  addInstructionsSheet(workbook, template);
  addTemplateSheet(workbook, template);

  const data = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
}

/**
 * Reads the data worksheet of an uploaded workbook into the same record shape
 * as the CSV parser, so both formats share one validation path. The downloaded
 * template carries an instructions sheet first, so the "Template" sheet is
 * preferred when it exists. Fully empty rows are skipped and row numbers stay
 * aligned with the spreadsheet.
 */
export async function readWorkbookRecords(content: Buffer): Promise<CsvRecord[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content as unknown as ArrayBuffer);

  const sheet =
    workbook.worksheets.find((candidate) => candidate.name.trim().toLowerCase() === 'template') ??
    workbook.worksheets[0];
  if (!sheet) return [];

  const records: CsvRecord[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: string[] = [];
    const columnCount = Math.max(row.cellCount, sheet.columnCount);
    for (let column = 1; column <= columnCount; column += 1) {
      values.push(cellText(row.getCell(column).value));
    }

    // Trailing blanks are dropped so mapping never depends on padded columns.
    while (values.length > 0 && values[values.length - 1] === '') values.pop();
    if (values.some((value) => value !== '')) {
      records.push({ line: rowNumber, values });
    }
  });

  return records;
}
