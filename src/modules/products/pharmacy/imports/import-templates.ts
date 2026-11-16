import { normalizeHeader } from './csv';

export const IMPORT_TYPES = ['PRODUCTS', 'BATCHES', 'INITIAL_STOCK'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export interface ImportColumn {
  key: string;
  header: string;
  required: boolean;
  description: string;
  example: string;
  aliases: string[];
}

export interface ImportTemplate {
  type: ImportType;
  label: string;
  summary: string;
  columns: ImportColumn[];
  instructions: string[];
  samples: string[][];
}

const PRODUCT_COLUMNS: ImportColumn[] = [
  {
    key: 'product_name',
    header: 'Product name',
    required: true,
    description: 'Full product name. Required and must be unique per pharmacy.',
    example: 'Paracetamol 500mg Tablet',
    aliases: ['product', 'medicine', 'medicine_name', 'drug', 'item', 'name'],
  },
  {
    key: 'brand',
    header: 'Brand',
    required: false,
    description: 'Manufacturer or brand name.',
    example: 'Emzor',
    aliases: ['manufacturer', 'brand_name'],
  },
  {
    key: 'strength',
    header: 'Strength',
    required: false,
    description: 'Strength as printed on the pack.',
    example: '500mg',
    aliases: ['dose', 'dose_strength', 'mg'],
  },
  {
    key: 'dosage_form',
    header: 'Dosage form',
    required: false,
    description: 'Tablet, capsule, syrup, injection, cream, etc.',
    example: 'Tablet',
    aliases: ['form', 'dosage', 'presentation'],
  },
  {
    key: 'pack_size',
    header: 'Pack size',
    required: false,
    description: 'Pack description, for example 10 x 10 tablets.',
    example: '10 x 10',
    aliases: ['pack', 'packsize', 'package_size'],
  },
  {
    key: 'unit',
    header: 'Unit',
    required: true,
    description: 'Base unit used for stock movements (tablet, bottle, sachet...).',
    example: 'tablet',
    aliases: ['units', 'uom', 'unit_of_measure'],
  },
  {
    key: 'barcode',
    header: 'Barcode',
    required: false,
    description: 'EAN/UPC barcode or internal SKU. Must be unique per pharmacy.',
    example: '6151100010203',
    aliases: ['ean', 'upc', 'sku', 'bar_code', 'product_code'],
  },
  {
    key: 'reorder_threshold',
    header: 'Reorder threshold',
    required: false,
    description: 'Minimum recorded quantity before the product is flagged as low stock.',
    example: '50',
    aliases: ['reorder_level', 'reorder_point', 'minimum_stock', 'min_stock'],
  },
  {
    key: 'active',
    header: 'Active',
    required: false,
    description: 'TRUE or FALSE. Defaults to TRUE when left blank.',
    example: 'TRUE',
    aliases: ['enabled', 'is_active'],
  },
];

const BATCH_COLUMNS: ImportColumn[] = [
  {
    key: 'product_name',
    header: 'Product name',
    required: true,
    description: 'Must match an existing product in the catalogue exactly.',
    example: 'Paracetamol 500mg Tablet',
    aliases: ['product', 'medicine', 'medicine_name', 'name'],
  },
  {
    key: 'batch_number',
    header: 'Batch number',
    required: true,
    description: 'Batch or lot number printed on the pack.',
    example: 'PC2451',
    aliases: ['batch', 'batch_no', 'lot', 'lot_number'],
  },
  {
    key: 'expiry_date',
    header: 'Expiry date',
    required: true,
    description: 'Expiry date. Accepted formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY.',
    example: '2027-04-30',
    aliases: ['expiry', 'expiry_date', 'exp_date', 'expires', 'expiration_date'],
  },
  {
    key: 'quantity',
    header: 'Quantity',
    required: true,
    description: 'Quantity recorded into this batch. Must be greater than zero.',
    example: '240',
    aliases: ['qty', 'quantity_received', 'received_quantity'],
  },
  {
    key: 'unit',
    header: 'Unit',
    required: false,
    description: 'Overrides the product unit when the batch uses a different unit.',
    example: 'tablet',
    aliases: ['units', 'uom'],
  },
  {
    key: 'unit_cost',
    header: 'Unit cost',
    required: false,
    description: 'Cost price per unit in Naira. Numbers only, no currency symbol.',
    example: '18.50',
    aliases: ['cost', 'cost_price', 'buying_price', 'unit_price'],
  },
  {
    key: 'selling_price',
    header: 'Selling price',
    required: false,
    description: 'Selling price per unit in Naira. Required before profit can be calculated.',
    example: '25.00',
    aliases: ['price', 'retail_price', 'sale_price'],
  },
];

const INITIAL_STOCK_COLUMNS: ImportColumn[] = [
  {
    key: 'product_name',
    header: 'Product name',
    required: true,
    description: 'Must match an existing product in the catalogue exactly.',
    example: 'Amoxicillin 250mg Capsule',
    aliases: ['product', 'medicine', 'medicine_name', 'name'],
  },
  {
    key: 'quantity',
    header: 'Quantity',
    required: true,
    description: 'Quantity physically counted. Must be greater than zero.',
    example: '120',
    aliases: ['qty', 'counted_quantity', 'opening_quantity'],
  },
  {
    key: 'batch_number',
    header: 'Batch number',
    required: false,
    description: 'Batch number when it is known.',
    example: 'AMX-118',
    aliases: ['batch', 'batch_no', 'lot', 'lot_number'],
  },
  {
    key: 'expiry_date',
    header: 'Expiry date',
    required: false,
    description: 'Expiry date when it is known. Accepted formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY.',
    example: '05/09/2027',
    aliases: ['expiry', 'exp_date', 'expires', 'expiration_date'],
  },
  {
    key: 'unit',
    header: 'Unit',
    required: false,
    description: 'Unit for this opening quantity.',
    example: 'capsule',
    aliases: ['units', 'uom'],
  },
  {
    key: 'unit_cost',
    header: 'Unit cost',
    required: false,
    description: 'Cost per unit in Naira.',
    example: '22.00',
    aliases: ['cost', 'cost_price', 'buying_price'],
  },
  {
    key: 'selling_price',
    header: 'Selling price',
    required: false,
    description: 'Selling price per unit in Naira.',
    example: '35.00',
    aliases: ['price', 'retail_price', 'sale_price'],
  },
];

const COMMON_INSTRUCTIONS = [
  'Save this sheet as a CSV file (comma delimited) before uploading.',
  'Do not rename or delete the header row. Extra columns are ignored.',
  'Do not change the order of the columns.',
  'Rows that fail validation are never imported silently; download the error report and correct them.',
  'Delete the sample rows before adding your own records.',
];

export const IMPORT_TEMPLATES: Record<ImportType, ImportTemplate> = {
  PRODUCTS: {
    type: 'PRODUCTS',
    label: 'Product catalogue',
    summary: 'Create products in the pharmacy catalogue. Products with an existing name are reported as duplicates.',
    columns: PRODUCT_COLUMNS,
    instructions: [
      ...COMMON_INSTRUCTIONS,
      'Product name and unit are required. Product names are compared ignoring case and punctuation.',
      'Barcodes are optional, but each barcode can only belong to one product in this pharmacy.',
    ],
    samples: [
      ['Paracetamol 500mg Tablet', 'Emzor', '500mg', 'Tablet', '10 x 10', 'tablet', '6151100010203', '50', 'TRUE'],
      ['Amoxicillin 250mg Capsule', 'GSK', '250mg', 'Capsule', '10 x 10', 'capsule', '', '40', 'TRUE'],
    ],
  },
  BATCHES: {
    type: 'BATCHES',
    label: 'Stock batches',
    summary: 'Record multiple stock batches against existing products. Each batch creates an opening stock movement.',
    columns: BATCH_COLUMNS,
    instructions: [
      ...COMMON_INSTRUCTIONS,
      'The product must already exist in the catalogue. Import products first if you are starting from scratch.',
      'Each imported batch is recorded as an opening stock movement and is visible in the audit trail.',
    ],
    samples: [
      ['Paracetamol 500mg Tablet', 'PC2451', '2027-04-30', '240', 'tablet', '18.50', '25.00'],
      ['Amoxicillin 250mg Capsule', 'AMX-118', '05/09/2027', '120', 'capsule', '22.00', '35.00'],
    ],
  },
  INITIAL_STOCK: {
    type: 'INITIAL_STOCK',
    label: 'Initial stock',
    summary: 'Load opening quantities for existing products during onboarding. Batch and expiry details are optional.',
    columns: INITIAL_STOCK_COLUMNS,
    instructions: [
      ...COMMON_INSTRUCTIONS,
      'Use this sheet when you are loading the pharmacy shelf for the first time.',
      'Every row creates a batch with an opening stock movement. Quantities are recorded balances, not counted stock.',
    ],
    samples: [
      ['Amoxicillin 250mg Capsule', '120', 'AMX-118', '2027-09-05', 'capsule', '22.00', '35.00'],
      ['Paracetamol 500mg Tablet', '500', '', '', 'tablet', '', ''],
    ],
  },
};

export function isImportType(value: string): value is ImportType {
  return (IMPORT_TYPES as readonly string[]).includes(value);
}

export function getTemplate(type: ImportType): ImportTemplate {
  return IMPORT_TEMPLATES[type];
}

export function buildTemplateCsv(type: ImportType): string {
  const template = getTemplate(type);
  const instructions = [
    `# ${template.label} import template`,
    `# ${template.summary}`,
    ...template.instructions.map((instruction) => `# ${instruction}`),
    `# Required fields: ${template.columns.filter((column) => column.required).map((column) => column.header).join(', ')}`,
    '# Accepted date formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY. Quantities use numbers only.',
  ];

  const headerRow = template.columns.map((column) => column.header);
  const rows = [
    ...instructions.map((line) => [line]),
    [],
    headerRow,
    ...template.samples,
  ];

  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? '';
          return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(','),
    )
    .join('\r\n')
    .concat('\r\n');
}

export interface ResolvedMapping {
  /** Template column key -> normalised header present in the file (or null). */
  mapping: Record<string, string | null>;
  missingRequired: string[];
}

/**
 * Resolves template columns against the uploaded header row. Callers may pass an
 * explicit mapping (template key -> original header label) from the UI to resolve
 * columns that use unusual names.
 */
export function resolveMapping(
  type: ImportType,
  headers: string[],
  overrides?: Record<string, string>,
): ResolvedMapping {
  const template = getTemplate(type);
  const normalizedHeaders = headers.map((header) => ({ raw: header, normalized: normalizeHeader(header) }));
  const mapping: Record<string, string | null> = {};

  for (const column of template.columns) {
    const override = overrides?.[column.key];
    if (override) {
      const match = normalizedHeaders.find(
        (header) => header.raw === override || header.normalized === normalizeHeader(override),
      );
      mapping[column.key] = match ? match.raw : null;
      continue;
    }

    const candidates = new Set(
      [column.key, column.header, ...column.aliases].map((value) => normalizeHeader(value)),
    );
    const match = normalizedHeaders.find((header) => candidates.has(header.normalized));
    mapping[column.key] = match ? match.raw : null;
  }

  const missingRequired = template.columns
    .filter((column) => column.required && !mapping[column.key])
    .map((column) => column.header);

  return { mapping, missingRequired };
}
