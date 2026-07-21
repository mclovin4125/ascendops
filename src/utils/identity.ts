/**
 * Parse the user-facing display name out of an agent's IDENTITY.md content.
 *
 * "## Name" (the value on the first non-empty, non-comment line under it)
 * takes priority since it is the operator-configured name set during
 * onboarding. If that section is absent or still an unfilled template
 * placeholder (e.g. an HTML comment), fall back to the file's top-level
 * "# " heading so callers still get something more useful than nothing.
 */
export function parseDisplayNameFromIdentity(content: string): string | undefined {
  const lines = content.split('\n');

  const nameIdx = lines.findIndex(l => l.trim() === '## Name');
  if (nameIdx >= 0) {
    for (let i = nameIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('<!--')) continue;
      if (line.startsWith('#')) break;
      return line;
    }
  }

  const h1 = lines.find(l => l.startsWith('# ') && !l.startsWith('## '));
  if (h1) return h1.replace(/^#\s+/, '').trim();

  return undefined;
}
