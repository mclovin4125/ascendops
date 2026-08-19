/**
 * tests/integration/cron-pipeline-cross-pr.test.ts
 *
 * Cross-PR integration coverage for:
 *   - PR #15: daemon-side per-fire cron definition refresh + corruption fallback
 *   - PR #16: merge-aware `bus reload-crons` config.json -> crons.json sync
 *
 * This test proves the combined operator workflow:
 *   1. config.json defines one cron
 *   2. `bus reload-crons` populates state crons.json
 *   3. the daemon scheduler starts from state
 *   4. config.json is edited mid-flight to add a second cron
 *   5. `bus reload-crons` merges the new cron into state and signals daemon reload
 *   6. a live prompt edit in state is picked up at fire time without another reload
 *   7. catastrophic state-file corruption still falls back to the last-good schedule
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// IPC mock — lets the CLI send reload-crons through the same surface while
// the test controls what "the daemon" does when it receives the signal.
// ---------------------------------------------------------------------------

const mockIpcSend = vi.fn();

vi.mock('../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockIpcSend;
  }
  return { IPCClient: MockIPCClient };
});

// ---------------------------------------------------------------------------
// Imports AFTER IPC mock
// ---------------------------------------------------------------------------

import { busCommand } from '../../src/cli/bus';
import { CronScheduler } from '../../src/daemon/cron-scheduler.js';

// ---------------------------------------------------------------------------
// Constants / env wiring
// ---------------------------------------------------------------------------

const AGENT = 'boris';
const ORG = 'lifeos';
const TICK_MS = 30_000;
const ONE_MIN = 60_000;

let tmpRoot: string;
let frameworkRoot: string;

const originalCtxRoot = process.env.CTX_ROOT;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalAgentName = process.env.CTX_AGENT_NAME;
const originalInstanceId = process.env.CTX_INSTANCE_ID;

function agentConfigPath(): string {
  return join(frameworkRoot, 'orgs', ORG, 'agents', AGENT, 'config.json');
}

function stateCronsPath(): string {
  return join(tmpRoot, '.cortextOS', 'state', 'agents', AGENT, 'crons.json');
}

function stateCronsBakPath(): string {
  return stateCronsPath() + '.bak';
}

function readStateCrons(): CronDefinition[] {
  const raw = readFileSync(stateCronsPath(), 'utf-8');
  return JSON.parse(raw).crons as CronDefinition[];
}

function writeAgentConfig(crons: Array<Record<string, unknown>>): void {
  writeFileSync(
    agentConfigPath(),
    JSON.stringify({ runtime: 'claude', crons }, null, 2),
    'utf-8',
  );
}

function updateStatePrompt(name: string, prompt: string): void {
  const raw = JSON.parse(readFileSync(stateCronsPath(), 'utf-8'));
  raw.updated_at = new Date().toISOString();
  raw.crons = (raw.crons as CronDefinition[]).map(cron =>
    cron.name === name ? { ...cron, prompt } : cron,
  );
  writeFileSync(stateCronsPath(), JSON.stringify(raw, null, 2), 'utf-8');
}

async function advanceSim(totalMs: number, stepMs = ONE_MIN): Promise<void> {
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i++) {
    const remaining = totalMs - i * stepMs;
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, remaining));
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-cross-pr-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cron-cross-pr-fw-'));

  mkdirSync(join(frameworkRoot, 'orgs', ORG, 'agents', AGENT), { recursive: true });

  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_AGENT_NAME = AGENT;
  process.env.CTX_INSTANCE_ID = 'default';

  mockIpcSend.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;

  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  else delete process.env.CTX_FRAMEWORK_ROOT;

  if (originalAgentName !== undefined) process.env.CTX_AGENT_NAME = originalAgentName;
  else delete process.env.CTX_AGENT_NAME;

  if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId;
  else delete process.env.CTX_INSTANCE_ID;

  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(frameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cross-PR cron pipeline: reload-crons + daemon refresh', () => {
  it('merges new config cron into state, fires it with live prompt refresh, and survives corruption fallback', async () => {
    writeAgentConfig([
      {
        name: 'daily-check',
        interval: '1h',
        prompt: 'Daily check prompt.',
        type: 'recurring',
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Bootstrap state from config via the real CLI surface.
    mockIpcSend.mockResolvedValue({ success: true, data: 'mocked' });
    await busCommand.parseAsync(['node', 'bus', 'reload-crons', AGENT, '--json']);
    expect(errSpy).not.toHaveBeenCalled();
    expect(existsSync(stateCronsPath())).toBe(true);
    expect(readStateCrons().map(c => c.name)).toEqual(['daily-check']);

    const logs: string[] = [];
    const fired: Array<{ name: string; prompt: string }> = [];
    const scheduler = new CronScheduler({
      agentName: AGENT,
      onFire: (cron) => {
        fired.push({ name: cron.name, prompt: cron.prompt });
      },
      logger: (msg) => { logs.push(msg); },
    });
    scheduler.start();
    expect(scheduler.getNextFireTimes().map(c => c.name)).toEqual(['daily-check']);

    // Mid-flight config edit: add a second cron, then call the real CLI command.
    writeAgentConfig([
      {
        name: 'daily-check',
        interval: '1h',
        prompt: 'Daily check prompt.',
        type: 'recurring',
      },
      {
        name: 'new-fast-cron',
        interval: '5m',
        prompt: 'Initial fast prompt.',
        type: 'recurring',
      },
    ]);

    mockIpcSend.mockImplementation(async (request: { type?: string; agent?: string }) => {
      if (request.type === 'reload-crons' && request.agent === AGENT) {
        scheduler.reload();
      }
      return { success: true, data: 'reloaded' };
    });

    await busCommand.parseAsync(['node', 'bus', 'reload-crons', AGENT, '--json']);

    const stateAfterReload = readStateCrons();
    expect(stateAfterReload.map(c => c.name).sort()).toEqual(['daily-check', 'new-fast-cron']);
    expect(scheduler.getNextFireTimes().map(c => c.name).sort()).toEqual(['daily-check', 'new-fast-cron']);

    // Live-edit the state prompt without another reload — PR #15 should pick
    // this up at fire time via per-fire definition refresh.
    updateStatePrompt('new-fast-cron', 'Live-updated fast prompt.');

    await advanceSim(6 * ONE_MIN + TICK_MS);

    expect(fired.some(f => f.name === 'new-fast-cron')).toBe(true);
    const firstFastFire = fired.find(f => f.name === 'new-fast-cron');
    expect(firstFastFire?.prompt).toBe('Live-updated fast prompt.');

    // Bonus: corrupt BOTH state files, reload, and verify the last-good
    // schedule still fires the cached cron definition.
    const firesBeforeCorruption = fired.length;
    writeFileSync(stateCronsPath(), '{ definitely corrupted', 'utf-8');
    writeFileSync(stateCronsBakPath(), 'bak also corrupted', 'utf-8');
    scheduler.reload();

    expect(logs.some(l => l.includes('retaining last-good schedule'))).toBe(true);

    await advanceSim(6 * ONE_MIN + TICK_MS);
    scheduler.stop();

    expect(fired.length).toBeGreaterThan(firesBeforeCorruption);
    expect(fired.filter(f => f.name === 'new-fast-cron').length).toBeGreaterThanOrEqual(2);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('propagates wake_on_fire flag from config.json to state crons.json on reload, and toggles cleanly', async () => {
    // Operator opts a cron into the shift-gate bypass via config.json.
    // bus reload-crons must (a) carry the flag through to state on first sync,
    // and (b) treat wake_on_fire as config-authoritative so flipping the value
    // in config.json propagates on the next reload.

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIpcSend.mockResolvedValue({ success: true, data: 'mocked' });

    // 1. Initial reload — flag set true in config.
    writeAgentConfig([
      {
        name: 'shift-bypass-cron',
        cron: '15 7 * * 1-5',
        prompt: 'Run every weekday morning regardless of shift.',
        type: 'recurring',
        wake_on_fire: true,
      },
    ]);
    await busCommand.parseAsync(['node', 'bus', 'reload-crons', AGENT, '--json']);
    let state = readStateCrons();
    expect(state).toHaveLength(1);
    expect(state[0].name).toBe('shift-bypass-cron');
    expect(state[0].wake_on_fire).toBe(true);

    // 2. Operator removes the flag in config — second reload must clear it
    //    in state (proves wake_on_fire is in CONFIG_AUTHORITATIVE_FIELDS).
    writeAgentConfig([
      {
        name: 'shift-bypass-cron',
        cron: '15 7 * * 1-5',
        prompt: 'Run every weekday morning regardless of shift.',
        type: 'recurring',
      },
    ]);
    await busCommand.parseAsync(['node', 'bus', 'reload-crons', AGENT, '--json']);
    state = readStateCrons();
    expect(state).toHaveLength(1);
    expect(state[0].wake_on_fire).toBeFalsy();

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('propagates emergency_allowed flag from config.json to state crons.json on reload, and toggles cleanly', async () => {
    // Sibling of the wake_on_fire propagation test above — emergency_allowed is
    // the softer, off_shift_emergency_only-only exemption (see
    // AgentManager.evaluateCronShiftSuppression). Same CONFIG_AUTHORITATIVE_FIELDS
    // contract: reload must carry the flag through on first sync and clear it
    // when the operator removes it from config.json.

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIpcSend.mockResolvedValue({ success: true, data: 'mocked' });

    // 1. Initial reload — flag set true in config.
    writeAgentConfig([
      {
        name: 'emergency-only-cron',
        cron: '0 3 * * *',
        prompt: 'Detection-only scan, safe to run during an emergency-only window.',
        type: 'recurring',
        emergency_allowed: true,
      },
    ]);
    await busCommand.parseAsync(['node', 'bus', 'reload-crons', AGENT, '--json']);
    let state = readStateCrons();
    expect(state).toHaveLength(1);
    expect(state[0].name).toBe('emergency-only-cron');
    expect(state[0].emergency_allowed).toBe(true);

    // 2. Operator removes the flag in config — second reload must clear it
    //    in state (proves emergency_allowed is in CONFIG_AUTHORITATIVE_FIELDS).
    writeAgentConfig([
      {
        name: 'emergency-only-cron',
        cron: '0 3 * * *',
        prompt: 'Detection-only scan, safe to run during an emergency-only window.',
        type: 'recurring',
      },
    ]);
    await busCommand.parseAsync(['node', 'bus', 'reload-crons', AGENT, '--json']);
    state = readStateCrons();
    expect(state).toHaveLength(1);
    expect(state[0].emergency_allowed).toBeFalsy();

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
