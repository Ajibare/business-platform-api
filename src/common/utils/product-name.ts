/**
 * Product names are compared with the same normalisation used by the catalogue,
 * so spreadsheet imports cannot create near-duplicate products.
 */
export function normalizeProductName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
