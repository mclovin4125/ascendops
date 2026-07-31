import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts', 'fix-pty-spawn-helper.mjs');

function run(root: string) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, root], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

let tmp: string;

function prebuildDir(platform: string) {
  return join(tmp, 'node_modules', 'node-pty', 'prebuilds', platform);
}

/** Create a spawn-helper for `platform` with an explicit mode. */
function makeHelper(platform: string, mode: number) {
  const dir = prebuildDir(platform);
  mkdirSync(dir, { recursive: true });
  const helper = join(dir, 'spawn-helper');
  writeFileSync(helper, '#!/bin/sh\nexit 0\n');
  chmodSync(helper, mode);
  return helper;
}

function mode(path: string) {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fix-pty-spawn-helper-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('fix-pty-spawn-helper', () => {
  // The bug this guards: node-pty execs spawn-helper for every PTY, so a 0644
  // helper fails every agent spawn with an opaque `posix_spawnp failed.`
  it('restores the executable bit on a non-executable helper', () => {
    const helper = makeHelper('darwin-x64', 0o644);

    const result = run(tmp);

    expect(result.status).toBe(0);
    expect(mode(helper)).toBe(0o755);
    expect(result.stdout).toContain('restored +x');
  });

  it('repairs every prebuilt platform, not just the host one', () => {
    const x64 = makeHelper('darwin-x64', 0o644);
    const arm64 = makeHelper('darwin-arm64', 0o644);

    const result = run(tmp);

    expect(result.status).toBe(0);
    expect(mode(x64)).toBe(0o755);
    expect(mode(arm64)).toBe(0o755);
  });

  it('leaves an already-executable helper untouched and stays quiet', () => {
    const helper = makeHelper('darwin-x64', 0o755);

    const result = run(tmp);

    expect(result.status).toBe(0);
    expect(mode(helper)).toBe(0o755);
    expect(result.stdout).not.toContain('restored +x');
  });

  it('preserves non-exec permission bits when adding +x', () => {
    const helper = makeHelper('darwin-x64', 0o600);

    const result = run(tmp);

    expect(result.status).toBe(0);
    // 0o600 | 0o111 — the read/write bits survive, exec is added.
    expect(mode(helper)).toBe(0o711);
  });

  it('succeeds when node-pty is absent so it can never fail an install', () => {
    const result = run(tmp);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to do');
  });

  it('ignores prebuild dirs that ship no spawn-helper (win32)', () => {
    const dir = prebuildDir('win32-x64');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pty.node'), 'binary');

    const result = run(tmp);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
