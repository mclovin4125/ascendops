import { describe, it, expect } from 'vitest';
import { pad } from '../../../src/utils/format.js';

// Confirmed defect (2026-07-21): plain `str.padEnd(width)` silently runs a
// column into the next one whenever a real value (e.g. the 18-char org slug
// "lane-family-homes", or the 20-char agent name "maintenance-director") is
// longer than the column's target width — e.g. "lane-family-homesSystem
// Analyst..." with no separating space at all. Both list-agents and status
// hit this.
describe('pad', () => {
  it('pads short values up to the target width', () => {
    expect(pad('dev', 18)).toBe('dev'.padEnd(18));
    expect(pad('dev', 18)).toHaveLength(18);
  });

  it('guarantees at least one separating space when the value is longer than the width', () => {
    const value = 'lane-family-homes'; // 18 chars, longer than the org column's width of 17
    const result = pad(value, 17);
    expect(result).toBe('lane-family-homes ');
    expect(result.endsWith(' ')).toBe(true);
  });

  it('guarantees a separating space when the value is exactly the target width', () => {
    const value = 'x'.repeat(18);
    expect(pad(value, 18)).toBe(`${value} `);
  });
});
