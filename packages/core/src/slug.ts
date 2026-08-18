/** Lowercases, strips unsafe characters, and collapses/trims separators into a URL/DNS-safe slug. */
export function sanitizeSlug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!cleaned) {
    throw new Error(`"${input}" contains no usable alphanumeric characters for a slug`);
  }
  return cleaned;
}
