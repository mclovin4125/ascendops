/**
 * tests/unit/cli/update-approval-command.test.ts
 *
 * Covers the `bus update-approval` CLI bug fixed alongside the stdin issue
 * in _finalize.ts: --help described the status argument as "approved or
 * denied" but the validator only ever accepted 'approved' | 'rejected',
 * silently rejecting the exact word the help text advertised.
 *
 * Strategy mirrors tests/unit/cli/bus-crons.test.ts: `busCommand` is a
 * module-level singleton, so commands are exercised via
 * `busCommand.parseAsync([...])` rather than re-importing the module.
 *
 * `resolvePaths` resolves the ctx root via `resolveCanonicalCtxRoot`, which
 * reads CTX_INSTANCE_ID (NOT CTX_ROOT — that env var is ignored for this
 * path). A unique per-test instance id keeps this test writing under
 * ~/.cortextos/<unique-id>/ instead of the real `default` instance that a
 * live agent on this machine actually uses, and the dir is removed after.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import type { Approval } from '../../../src/types/index';

// updateApproval() notifies the requesting agent via sendMessage — stub it
// out so the test never touches the real inbox files.
const sendMessageSpy = vi.fn();
vi.mock('../../../src/bus/message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/message')>();
  return {
    ...actual,
    sendMessage: (...args: unknown[]) => sendMessageSpy(...args),
  };
});

import { busCommand } from '../../../src/cli/bus';

const TEST_ORG = 'TestOrg';
const RESOLVING_AGENT = 'mack-approver'; // must differ from requesting_agent below
const REQUESTING_AGENT = 'leasing';

let instanceId: string;
let approvalDir: string;

const originalEnv = {
  CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID,
  CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
  CTX_ORG: process.env.CTX_ORG,
};

function pendingPath(id: string): string {
  return join(approvalDir, 'pending', `${id}.json`);
}

function resolvedPath(id: string): string {
  return join(approvalDir, 'resolved', `${id}.json`);
}

/** Seed a pending approval directly on disk (bypasses createApproval's activity-channel fan-out). */
function seedPending(id: string): void {
  const dir = join(approvalDir, 'pending');
  mkdirSync(dir, { recursive: true });
  const approval: Approval = {
    id,
    title: 'Test approval',
    requesting_agent: REQUESTING_AGENT,
    org: TEST_ORG,
    category: 'other',
    status: 'pending',
    description: '',
    created_at: '2026-10-21T00:00:00Z',
    updated_at: '2026-10-21T00:00:00Z',
    resolved_at: null,
    resolved_by: null,
  };
  writeFileSync(pendingPath(id), JSON.stringify(approval), 'utf-8');
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

beforeEach(() => {
  instanceId = `test-update-approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_AGENT_NAME = RESOLVING_AGENT;
  process.env.CTX_ORG = TEST_ORG;
  approvalDir = join(homedir(), '.cortextos', instanceId, 'orgs', TEST_ORG, 'approvals');
  sendMessageSpy.mockClear();
});

afterEach(() => {
  if (originalEnv.CTX_INSTANCE_ID !== undefined) process.env.CTX_INSTANCE_ID = originalEnv.CTX_INSTANCE_ID;
  else delete process.env.CTX_INSTANCE_ID;
  if (originalEnv.CTX_AGENT_NAME !== undefined) process.env.CTX_AGENT_NAME = originalEnv.CTX_AGENT_NAME;
  else delete process.env.CTX_AGENT_NAME;
  if (originalEnv.CTX_ORG !== undefined) process.env.CTX_ORG = originalEnv.CTX_ORG;
  else delete process.env.CTX_ORG;

  try {
    rmSync(join(homedir(), '.cortextos', instanceId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

describe('bus update-approval — accepted status values', () => {
  it('accepts "approved"', async () => {
    const id = 'approval_test_approved';
    seedPending(id);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'update-approval', id, 'approved']);

    expect(logSpy).toHaveBeenCalledWith(`Approval ${id} -> approved`);
    expect(existsSync(pendingPath(id))).toBe(false);
    const resolved: Approval = JSON.parse(readFileSync(resolvedPath(id), 'utf-8'));
    expect(resolved.status).toBe('approved');
  });

  it('accepts "rejected"', async () => {
    const id = 'approval_test_rejected';
    seedPending(id);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'update-approval', id, 'rejected']);

    expect(logSpy).toHaveBeenCalledWith(`Approval ${id} -> rejected`);
    const resolved: Approval = JSON.parse(readFileSync(resolvedPath(id), 'utf-8'));
    expect(resolved.status).toBe('rejected');
  });

  it('accepts "denied" as an alias and normalizes it to "rejected" (the help/parser mismatch this fixes)', async () => {
    const id = 'approval_test_denied_alias';
    seedPending(id);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'update-approval', id, 'denied']);

    // Logged/stored status is the real ApprovalStatus value, not the alias.
    expect(logSpy).toHaveBeenCalledWith(`Approval ${id} -> rejected`);
    const resolved: Approval = JSON.parse(readFileSync(resolvedPath(id), 'utf-8'));
    expect(resolved.status).toBe('rejected');
  });

  it('still rejects a genuinely invalid status with the correct accepted-values message', async () => {
    const id = 'approval_test_invalid';
    seedPending(id);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'update-approval', id, 'maybe']),
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(errSpy).toHaveBeenCalledWith("Invalid status 'maybe'. Must be one of: approved, rejected");
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Untouched — still pending.
    expect(existsSync(pendingPath(id))).toBe(true);
  });

  it('runs a loop of 3 sequential calls without any of them failing or hanging (the shape of the broken while-read loop)', async () => {
    const ids = ['approval_test_loop_1', 'approval_test_loop_2', 'approval_test_loop_3'];
    const statuses = ['approved', 'denied', 'rejected'];
    ids.forEach(seedPending);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    for (let i = 0; i < ids.length; i++) {
      await busCommand.parseAsync(['node', 'bus', 'update-approval', ids[i], statuses[i]]);
    }

    expect(logSpy).toHaveBeenCalledWith(`Approval ${ids[0]} -> approved`);
    expect(logSpy).toHaveBeenCalledWith(`Approval ${ids[1]} -> rejected`); // denied alias
    expect(logSpy).toHaveBeenCalledWith(`Approval ${ids[2]} -> rejected`);
    for (const id of ids) {
      expect(existsSync(pendingPath(id))).toBe(false);
      expect(existsSync(resolvedPath(id))).toBe(true);
    }
  });
});
