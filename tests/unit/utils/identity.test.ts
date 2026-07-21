import { describe, it, expect } from 'vitest';
import { parseDisplayNameFromIdentity } from '../../../src/utils/identity.js';

describe('parseDisplayNameFromIdentity', () => {
  it('parses the value under "## Name"', () => {
    const content = '# Agent Identity\n\n## Name\nMason\n\n## Role\nSomething\n';
    expect(parseDisplayNameFromIdentity(content)).toBe('Mason');
  });

  it('falls back to the top-level heading when "## Name" is an unfilled placeholder comment', () => {
    // This is exactly the un-onboarded IDENTITY.md stub template shape.
    const content = '# Agent Identity\n\n## Name\n<!-- Agent name (set during onboarding) -->\n\n## Role\n<!-- role -->\n';
    expect(parseDisplayNameFromIdentity(content)).toBe('Agent Identity');
  });

  it('falls back to the top-level heading when "## Name" section is entirely absent', () => {
    const content = '# Some Agent\n\nNo name section here.\n';
    expect(parseDisplayNameFromIdentity(content)).toBe('Some Agent');
  });

  it('returns undefined when there is no "## Name" and no top-level heading', () => {
    const content = 'Just some text with no headings at all.\n';
    expect(parseDisplayNameFromIdentity(content)).toBeUndefined();
  });

  it('skips blank lines and HTML comments between "## Name" and the real value', () => {
    const content = '## Name\n<!-- comment -->\n\nToolbox\n\n## Role\nx\n';
    expect(parseDisplayNameFromIdentity(content)).toBe('Toolbox');
  });
});
