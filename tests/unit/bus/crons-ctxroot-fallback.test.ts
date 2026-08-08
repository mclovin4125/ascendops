/**
 * tests/unit/bus/crons-ctxroot-fallback.test.ts
 *
 * Regression test for the CTX_ROOT-unset false-negative: a shell with no
 * CTX_ROOT exported must resolve crons.json under the canonical
 * ~/.cortextos/{instance} default, NOT process.cwd(). Confirmed 2026-08-07 —
 * see the comment on cronsFilePath() in src/bus/crons.ts for the incident
 * this reproduces (list-crons silently read the wrong directory and printed
 * "No crons configured" for an agent that actually had crons loaded).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('crons.ts — CTX_ROOT-unset fallback', () => {
  let fakeHome: string;
  let fakeCwd: string;
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalInstanceId = process.env.CTX_INSTANCE_ID;
  const originalCwd = process.cwd();

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'crons-fallback-home-'));
    fakeCwd = mkdtempSync(join(tmpdir(), 'crons-fallback-cwd-'));
    delete process.env.CTX_ROOT;
    delete process.env.CTX_INSTANCE_ID;
    process.chdir(fakeCwd);
    vi.resetModules();
    vi.doMock('os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('os')>();
      return { ...actual, homedir: () => fakeHome };
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
    else delete process.env.CTX_ROOT;
    if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId;
    else delete process.env.CTX_INSTANCE_ID;
    vi.doUnmock('os');
    vi.resetModules();
    try { rmSync(fakeHome, { recursive: true }); } catch { /* ignore */ }
    try { rmSync(fakeCwd, { recursive: true }); } catch { /* ignore */ }
  });

  it('reads crons.json from ~/.cortextos/default, not process.cwd(), when CTX_ROOT is unset', async () => {
    const { CRONS_DIRECTORY, CRONS_FILENAME } = await import('../../../src/bus/crons-schema.js');

    const homeCronsDir = join(fakeHome, '.cortextos', 'default', CRONS_DIRECTORY, 'dev');
    mkdirSync(homeCronsDir, { recursive: true });
    writeFileSync(
      join(homeCronsDir, CRONS_FILENAME),
      JSON.stringify({
        updated_at: new Date().toISOString(),
        crons: [{ name: 'heartbeat', schedule: '4h', prompt: 'x', enabled: true }],
      }),
    );

    // Decoy at cwd, empty. If the old process.cwd() fallback were still
    // active this would be the file found (or nothing would be found at
    // all, depending on cwd layout) — either way the real crons.json above
    // would be missed.
    const cwdCronsDir = join(fakeCwd, CRONS_DIRECTORY, 'dev');
    mkdirSync(cwdCronsDir, { recursive: true });
    writeFileSync(
      join(cwdCronsDir, CRONS_FILENAME),
      JSON.stringify({ updated_at: new Date().toISOString(), crons: [] }),
    );

    const { readCrons } = await import('../../../src/bus/crons.js');
    const crons = readCrons('dev');

    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('heartbeat');
  });

  it('still honors CTX_ROOT when it is set, taking priority over the home-dir default', async () => {
    const { CRONS_DIRECTORY, CRONS_FILENAME } = await import('../../../src/bus/crons-schema.js');

    const explicitRoot = mkdtempSync(join(tmpdir(), 'crons-fallback-explicit-'));
    process.env.CTX_ROOT = explicitRoot;
    const explicitCronsDir = join(explicitRoot, CRONS_DIRECTORY, 'dev');
    mkdirSync(explicitCronsDir, { recursive: true });
    writeFileSync(
      join(explicitCronsDir, CRONS_FILENAME),
      JSON.stringify({
        updated_at: new Date().toISOString(),
        crons: [{ name: 'explicit-root', schedule: '1h', prompt: 'x', enabled: true }],
      }),
    );

    try {
      const { readCrons } = await import('../../../src/bus/crons.js');
      const crons = readCrons('dev');

      expect(crons).toHaveLength(1);
      expect(crons[0].name).toBe('explicit-root');
    } finally {
      try { rmSync(explicitRoot, { recursive: true }); } catch { /* ignore */ }
    }
  });
});
