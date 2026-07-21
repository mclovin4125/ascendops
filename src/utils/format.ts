/**
 * Pad a string for fixed-width table columns, guaranteeing at least one
 * separating space. Plain `str.padEnd(width)` silently runs a column into
 * the next one whenever a real value (e.g. the 18-char org slug
 * "lane-family-homes", or the 20-char agent name "maintenance-director")
 * is longer than or equal to the column's target width.
 */
export function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}
