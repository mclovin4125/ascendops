/**
 * tests/integration/fails-loud-exit-codes-cli.test.ts
 *
 * Drives the compiled `dist/cli.js bus ...` to prove the fails-loud exit-code
 * fix end-to-end through Commander + process.exit:
 *
 *   - SHAPE-A negative control: check-upstream against a NON-git dir returns
 *     {status:'error'} and the process exits 1 (was exit 0 before the fix).
 *   - SHAPE-A positive regression: browse-catalog against a frameworkRoot with
 *     an EMPTY catalog returns {status:'empty'} and exits 0 (must NOT regress).
 *   - SHAPE-B log-event: a passed-but-malformed --meta exits 1 with an error
 *     envelope; an absent --meta exits 0; a valid --meta exits 0.
 *
 * All cases run offline (no network): check-upstream short-circuits on "not a
 * git repository" before any fetch; browse-catalog reads a local catalog.json.
 *
 * Skipped when dist/cli.js is absent (build not run).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Every test here spawns a real `node dist/cli.js` subprocess. Confirmed
// flaky (2026-07-21) under a fully parallel `npm test` run — passes every
// time in isolation, but the default 10s testTimeout is occasionally too
// tight once dozens of test files are competing for CPU to spawn and run a
// full Node process each.
vi.setConfig({ testTimeout: 30000 });

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

let frameworkRoot: string;

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'fails-loud-'));
});

afterEach(() => {
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }
});

async function runBus(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, 'bus', ...args],
      {
        // Point framework/ctx roots at the tmp fixture; strip any inherited
        // agent-sandbox vars so the CLI resolves cleanly in CI.
        env: {
          ...process.env,
          CTX_FRAMEWORK_ROOT: frameworkRoot,
          CTX_ROOT: frameworkRoot,
          CTX_AGENT_NAME: 'tester',
          CTX_ORG: 'testorg',
        },
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

describe.skipIf(!existsSync(DIST_CLI))('bus fails-loud exit codes (CLI)', () => {
  it('SHAPE-A negative control: check-upstream on a non-git dir → status:error → exit 1', async () => {
    const { stdout, code } = await runBus(['check-upstream']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('error');
  });

  it('SHAPE-A positive regression: browse-catalog on an empty catalog → status:empty → exit 0', async () => {
    mkdirSync(join(frameworkRoot, 'community'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'community', 'catalog.json'),
      JSON.stringify({ version: '1.0.0', updated_at: '2026-04-15T00:00:00Z', items: [] }),
    );
    const { stdout, code } = await runBus(['browse-catalog']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('empty');
  });

  it('SHAPE-B log-event: malformed --meta → error envelope → exit 1', async () => {
    const { stdout, code } = await runBus(['log-event', 'action', 'test_event', 'info', '--meta', '{not valid json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('invalid --meta JSON');
  });

  it('SHAPE-B log-event: absent --meta → exit 0 (no false-positive)', async () => {
    const { stdout, code } = await runBus(['log-event', 'action', 'test_event', 'info']);
    expect(code).toBe(0);
    expect(stdout).toContain('Logged action/test_event');
  });

  it('SHAPE-B log-event: valid --meta → exit 0', async () => {
    const { stdout, code } = await runBus(['log-event', 'action', 'test_event', 'info', '--meta', '{"k":"v"}']);
    expect(code).toBe(0);
    expect(stdout).toContain('Logged action/test_event');
  });

  it('Class-D negative control: post-activity with no activity-channel config → exit 1', async () => {
    // frameworkRoot is a fresh tmp dir with no activity-channel.env, so
    // postActivity() returns false (offline — no Telegram call). Before the fix
    // the handler printed the error to stderr but exited 0.
    const { stderr, code } = await runBus(['post-activity', 'hello']);
    expect(code).toBe(1);
    expect(stderr).toContain('Failed to post activity');
  });
});
