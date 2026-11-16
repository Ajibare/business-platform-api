export interface CsvRecord {
  /** 1-based physical line in the uploaded file where the record starts. */
  line: number;
  values: string[];
}

/**
 * Parses RFC 4180 style CSV content.
 *
 * - Supports quoted fields, escaped quotes, embedded commas and newlines.
 * - Handles CRLF line endings and a UTF-8 BOM.
 * - Skips blank lines and `#` instruction lines so downloadable templates can
 *   carry guidance without breaking re-upload.
 */
export function parseCsv(content: string): CsvRecord[] {
  const text = content.replace(/^\uFEFF/, '');
  const records: CsvRecord[] = [];

  let field = '';
  let values: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 0;
  let started = false;

  const pushField = () => {
    values.push(field.trim());
    field = '';
  };

  const pushRecord = () => {
    pushField();
    const meaningful = values.some((value) => value !== '');
    const instructionLine = values[0]?.startsWith('#');
    if (meaningful && !instructionLine) {
      records.push({ line: recordLine || line, values });
    }
    values = [];
    started = false;
    recordLine = 0;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (!started && char !== '\n' && char !== '\r' && char !== ',') {
      started = true;
      recordLine = line;
    }

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      pushField();
      continue;
    }

    if (char === '\r') continue;

    if (char === '\n') {
      pushRecord();
      line += 1;
      continue;
    }

    field += char;
  }

  if (started || field !== '' || values.length > 0) {
    pushRecord();
  }

  return records;
}

export function toCsv(rows: string[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            const value = cell ?? '';
            return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
          })
          .join(','),
      )
      .join('\r\n') + '\r\n'
  );
}

/** Normalises a header label so `Product name`, `product name` and `PRODUCT_NAME` match. */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
