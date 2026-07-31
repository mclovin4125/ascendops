#!/usr/bin/env node

/**
 * Restore the executable bit on node-pty's prebuilt `spawn-helper`.
 *
 * node-pty ships `spawn-helper` inside its prebuilds, and on POSIX it forks and
 * execs that helper for *every* PTY it opens. Some npm/tarball extraction paths
 * land the file as 0644, and node-pty then fails every spawn with the opaque
 * message `posix_spawnp failed.` — with no mention of the helper, the file mode,
 * or even which binary could not be exec'd.
 *
 * For cortextOS that failure is fleet-wide and silent-ish: the daemon boots
 * fine, reads enabled-agents.json, reports each agent as configured, and then
 * every single agent dies at spawn. The symptom looks like an auth/config
 * problem, not a file permission, so it burns a lot of time to diagnose.
 *
 * Runs from `postinstall`, so a fresh `npm install`/`npm ci` self-heals instead
 * of reintroducing the fault. Never fails the install: a missing node-pty (or
 * anything unexpected) is reported and skipped, since this is a repair pass and
 * not a precondition.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const EXEC_BITS = 0o111;

export function getRepoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Locate every prebuilt spawn-helper shipped by node-pty under `root`. */
export function findSpawnHelpers(root) {
  const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(prebuilds)) return [];

  const helpers = [];
  for (const entry of readdirSync(prebuilds)) {
    const helper = join(prebuilds, entry, 'spawn-helper');
    if (existsSync(helper)) helpers.push(helper);
  }
  return helpers;
}

/**
 * Add the executable bits to `helper` if missing.
 * Returns 'fixed', 'already-executable', or an error string.
 */
export function ensureExecutable(helper) {
  try {
    const mode = statSync(helper).mode;
    if ((mode & EXEC_BITS) === EXEC_BITS) return 'already-executable';
    chmodSync(helper, mode | EXEC_BITS);
    return 'fixed';
  } catch (error) {
    return `error: ${error.message}`;
  }
}

export function main(root = getRepoRoot()) {
  // Windows has no spawn-helper (node-pty uses conpty/winpty there) and no
  // POSIX exec bit, so there is nothing to repair.
  if (process.platform === 'win32') return 0;

  const helpers = findSpawnHelpers(root);
  if (helpers.length === 0) {
    // node-pty absent is normal for consumers installing the published package
    // without dev deps — not an error worth failing the install over.
    console.log('[fix-pty-spawn-helper] no node-pty prebuilds found; nothing to do');
    return 0;
  }

  for (const helper of helpers) {
    const result = ensureExecutable(helper);
    if (result === 'fixed') {
      console.log(`[fix-pty-spawn-helper] restored +x on ${helper}`);
    } else if (result !== 'already-executable') {
      console.warn(`[fix-pty-spawn-helper] could not chmod ${helper}: ${result}`);
    }
  }
  return 0;
}

export function isDirectRun(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return import.meta.url === pathToFileURL(argvPath).href;
}

if (isDirectRun()) {
  // argv[2] lets the repair run against an arbitrary tree (used by tests).
  process.exitCode = main(process.argv[2] || getRepoRoot());
}
