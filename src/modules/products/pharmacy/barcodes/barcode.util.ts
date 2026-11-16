const BARCODE_PATTERN = /^[A-Z0-9._-]{4,64}$/;

/**
 * Barcodes and internally printed SKUs are stored in a canonical form so that
 * uniqueness within a pharmacy workspace is not weakened by letter casing or
 * surrounding whitespace.
 */
export function normalizeBarcode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidBarcode(value: string): boolean {
  return BARCODE_PATTERN.test(normalizeBarcode(value));
}
