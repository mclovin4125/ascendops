/**
 * tests/integration/fails-loud-messaging-cli.test.ts
 *
 * Part-2 fails-loud sweep — messaging sites. Drives the compiled
 * `dist/cli.js bus ...` to prove, end-to-end through Commander + the agentExists
 * gate + finalizeProcess drain:
 *
 *   send-message / create-task --assignee / update-task --assignee / notify-agent:
 *     - UNKNOWN recipient (resolvable agent universe) → exit 1, actionable stderr,
 *       and NO side-effect file (no inbox message, no .urgent-signal, no task).
 *     - --force → exit 0 and the side effect IS performed (pre-provisioning).
 *     - DISABLED-but-existing agent → exit 0 + side effect (existence, not enabled-state).
 *     - FRESH INSTALL / unresolvable agent list → exit 0 (fleet-brick guard: a real
 *       send must NOT be blocked when no agent universe is resolvable).
 *
 * Each case uses a UNIQUE CTX_INSTANCE_ID so the per-instance ~/.cortextos/<inst>
 * inbox/state tree is isolated and the side-effect assertion is deterministic.
 *
 * Skipped when dist/cli.js is absent (build not run).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { randomBytes } from 'crypto';
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
let instanceId: string;
let ctxRoot: string;

/** Create orgs/<org>/agents/<name>/ dirs so listAgents() resolves them. */
function makeAgentDirs(org: string, names: string[]): void {
  for (const n of names) {
    mkdirSync(join(frameworkRoot, 'orgs', org, 'agents', n), { recursive: true });
  }
}

/** Write enabled-agents.json into the per-instance ctxRoot. */
function writeEnabledAgents(entries: Record<string, { org?: string; enabled?: boolean }>): void {
  const cfgDir = join(ctxRoot, 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'enabled-agents.json'), JSON.stringify(entries));
}

function inboxFilesFor(agent: string): string[] {
  const dir = join(ctxRoot, 'inbox', agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

function signalFileFor(agent: string): string {
  return join(ctxRoot, 'state', agent, '.urgent-signal');
}

function taskFiles(): string[] {
  const dir = join(ctxRoot, 'orgs', 'testorg', 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'fl-msg-fw-'));
  instanceId = `fl-msg-${randomBytes(6).toString('hex')}`;
  ctxRoot = join(homedir(), '.cortextos', instanceId);
});

afterEach(() => {
  try { rmSync(frameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function runBus(
  args: string[],
  rootEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, 'bus', ...args],
      {
        env: {
          ...process.env,
          // Strip inherited agent-sandbox vars so the CLI resolves cleanly
          // against the tmp fixture (otherwise resolveEnv's "agentDir must be
          // under frameworkRoot" guard fires against the real install paths).
          CTX_AGENT_DIR: '',
          CTX_PROJECT_ROOT: frameworkRoot,
          CORTEXTOS_DIR: '',
          CTX_FRAMEWORK_ROOT: frameworkRoot,
          CTX_ROOT: ctxRoot,
          CTX_INSTANCE_ID: instanceId,
          CTX_AGENT_NAME: 'tester',
          CTX_ORG: 'testorg',
          // rootEnv overrides the framework-root resolution vars so a test can
          // exercise the CORTEXTOS_DIR-configured install path (CORTEXTOS_DIR set,
          // CTX_FRAMEWORK_ROOT unset) — see the P2 fix in src/bus/agents.ts.
          ...(rootEnv ?? {}),
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

describe.skipIf(!existsSync(DIST_CLI))('Part-2 fails-loud messaging (CLI)', () => {
  // --- send-message -------------------------------------------------------
  describe('send-message', () => {
    it('UNKNOWN recipient (resolvable universe) → exit 1, stderr, NO inbox file', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { stderr, code } = await runBus(['send-message', 'ghost', 'normal', 'hi']);
      expect(code).toBe(1);
      expect(stderr).toContain("agent 'ghost' not found");
      expect(stderr).toContain('--force');
      expect(inboxFilesFor('ghost')).toEqual([]);
    });

    it('--force on unknown recipient → exit 0 + inbox file written', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code } = await runBus(['send-message', 'ghost', 'normal', 'hi', '--force']);
      expect(code).toBe(0);
      expect(inboxFilesFor('ghost').length).toBe(1);
    });

    it('DISABLED-but-existing agent is still messageable → exit 0 + inbox file', async () => {
      makeAgentDirs('testorg', ['sleeper']);
      writeEnabledAgents({ sleeper: { org: 'testorg', enabled: false } });
      const { code } = await runBus(['send-message', 'sleeper', 'normal', 'wake when re-enabled']);
      expect(code).toBe(0);
      expect(inboxFilesFor('sleeper').length).toBe(1);
    });

    it('FRESH INSTALL / unresolvable agent list → exit 0 (fleet-brick guard)', async () => {
      // No orgs dir, no enabled-agents.json → listAgents() returns []. A real
      // send must NOT be blocked: degrade safe.
      const { code, stderr } = await runBus(['send-message', 'realagent', 'normal', 'hi']);
      expect(code).toBe(0);
      expect(stderr).toContain('could not resolve the agent list');
      expect(inboxFilesFor('realagent').length).toBe(1);
    });

    it('EXISTING enabled agent → exit 0 + inbox file (happy path)', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code } = await runBus(['send-message', 'realagent', 'normal', 'hi']);
      expect(code).toBe(0);
      expect(inboxFilesFor('realagent').length).toBe(1);
    });

    // P2 regression (Codex #82): a CORTEXTOS_DIR-configured install (CORTEXTOS_DIR
    // set, CTX_FRAMEWORK_ROOT unset) must resolve the SAME universe resolveEnv()
    // sees (env.ts precedence: CORTEXTOS_DIR || CTX_FRAMEWORK_ROOT). Before the fix
    // listAgents() read only CTX_FRAMEWORK_ROOT, so the universe was falsely
    // unresolvable → the gate silently degraded to warn+proceed (never fired).
    const CORTEXTOS_DIR_ENV = () => ({ CORTEXTOS_DIR: frameworkRoot, CTX_FRAMEWORK_ROOT: '' });

    it('CORTEXTOS_DIR-only + UNKNOWN recipient → exit 1 (gate fires via CORTEXTOS_DIR universe)', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code, stderr } = await runBus(['send-message', 'ghost', 'normal', 'hi'], CORTEXTOS_DIR_ENV());
      expect(code).toBe(1);
      expect(stderr).toContain("agent 'ghost' not found");
      expect(inboxFilesFor('ghost')).toEqual([]);
    });

    it('CORTEXTOS_DIR-only + EXISTING agent → exit 0 + inbox file (valid recipient not rejected)', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code } = await runBus(['send-message', 'realagent', 'normal', 'hi'], CORTEXTOS_DIR_ENV());
      expect(code).toBe(0);
      expect(inboxFilesFor('realagent').length).toBe(1);
    });
  });

  // --- create-task --assignee ---------------------------------------------
  describe('create-task --assignee', () => {
    it('UNKNOWN assignee → exit 1, NO task created', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code, stderr } = await runBus(['create-task', 'Do thing', '--assignee', 'ghost']);
      expect(code).toBe(1);
      expect(stderr).toContain("agent 'ghost' not found");
      expect(taskFiles()).toEqual([]);
    });

    it('--force on unknown assignee → exit 0 + task created', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code } = await runBus(['create-task', 'Do thing', '--assignee', 'ghost', '--force']);
      expect(code).toBe(0);
      expect(taskFiles().length).toBe(1);
    });
  });

  // --- update-task --assignee ---------------------------------------------
  describe('update-task --assignee', () => {
    it('UNKNOWN assignee → exit 1, no reassignment', async () => {
      makeAgentDirs('testorg', ['realagent']);
      // Create a real task first (self-assigned is fine — skips the gate).
      const created = await runBus(['create-task', 'Reassign me']);
      const taskId = created.stdout.trim().split('\n').pop() as string;
      const { code, stderr } = await runBus(['update-task', taskId, 'in_progress', '--assignee', 'ghost']);
      expect(code).toBe(1);
      expect(stderr).toContain("agent 'ghost' not found");
    });
  });

  // --- notify-agent --------------------------------------------------------
  describe('notify-agent', () => {
    it('UNKNOWN target → exit 1, NO .urgent-signal written', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code, stderr } = await runBus(['notify-agent', 'ghost', 'urgent thing']);
      expect(code).toBe(1);
      expect(stderr).toContain("agent 'ghost' not found");
      expect(existsSync(signalFileFor('ghost'))).toBe(false);
    });

    it('--force on unknown target → exit 0 + .urgent-signal written', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code } = await runBus(['notify-agent', 'ghost', 'urgent thing', '--force']);
      expect(code).toBe(0);
      expect(existsSync(signalFileFor('ghost'))).toBe(true);
    });

    it('EXISTING target → exit 0 + .urgent-signal written', async () => {
      makeAgentDirs('testorg', ['realagent']);
      const { code } = await runBus(['notify-agent', 'realagent', 'urgent thing']);
      expect(code).toBe(0);
      expect(existsSync(signalFileFor('realagent'))).toBe(true);
    });
  });

  // --- auto-commit drain (emitResult envelope) ----------------------------
  describe('auto-commit emitResult drain', () => {
    it('pipes the FULL JSON envelope and exits 0 on a clean/non-error report', async () => {
      // frameworkRoot is a tmp dir that is NOT a git repo → autoCommit returns a
      // non-error status. We assert the full envelope parses (no truncation) and
      // the exit code matches the status (drain-safe proof).
      const { stdout, code } = await runBus(['auto-commit', '--dry-run']);
      // Full envelope received intact:
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('status');
      // Non-error statuses stay exit 0; an 'error'/'conflict' would be exit 1.
      if (parsed.status === 'error' || parsed.status === 'conflict') {
        expect(code).toBe(1);
      } else {
        expect(code).toBe(0);
      }
    });
  });
});
