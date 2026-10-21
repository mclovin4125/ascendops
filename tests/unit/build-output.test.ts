import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const expectedHookOutputs = [
  'hooks/hook-session-restore.js',
  'hooks/hook-skill-autopr.js',
];

describe('build outputs', () => {
  it('emits required hook bundles from tsup entries', { timeout: 60_000 }, () => {
    // --out-dir points tsup at a scratch directory instead of the repo's own
    // dist/ (tsup.config.ts has clean: true, so a direct run here would wipe
    // and rebuild the real dist/cli.js that the live `cortextos` binary
    // resolves into, from whatever branch happens to be checked out).
    const outDir = mkdtempSync(join(tmpdir(), 'cortextos-build-output-test-'));
    try {
      execFileSync('npx', ['tsup', '--silent', '--out-dir', outDir], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });

      for (const outputPath of expectedHookOutputs) {
        expect(existsSync(join(outDir, outputPath)), outputPath).toBe(true);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
