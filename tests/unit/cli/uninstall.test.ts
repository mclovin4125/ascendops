import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { countPendingState } from '../../../src/cli/uninstall';

/**
 * Regression coverage for the 2026-08-07 incident: `cortextos uninstall`
 * (no --keep-state) previously ran a plain rmSync over ${CTX_ROOT} with no
 * check for pending approvals or open tasks — both live only in that
 * directory, so a rebuild/uninstall destroyed them with no trace. This
 * suite covers the counting logic the blocking check is built on.
 */
describe('countPendingState', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-uninstall-test-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function writeApproval(org: string, id: string): void {
    const dir = join(ctxRoot, 'orgs', org, 'approvals', 'pending');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, status: 'pending' }));
  }

  function writeTask(org: string, id: string, status: string): void {
    const dir = join(ctxRoot, 'orgs', org, 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, status }));
  }

  it('returns zero counts when no orgs directory exists', () => {
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 0, tasks: 0 });
  });

  it('returns zero counts for an empty orgs directory', () => {
    mkdirSync(join(ctxRoot, 'orgs', 'acme'), { recursive: true });
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 0, tasks: 0 });
  });

  it('counts pending approvals', () => {
    writeApproval('acme', 'approval_1');
    writeApproval('acme', 'approval_2');
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 2, tasks: 0 });
  });

  it('counts non-terminal tasks (pending, in_progress, blocked) but not completed or cancelled', () => {
    writeTask('acme', 'task_pending', 'pending');
    writeTask('acme', 'task_running', 'in_progress');
    writeTask('acme', 'task_blocked', 'blocked');
    writeTask('acme', 'task_done', 'completed');
    writeTask('acme', 'task_cancelled', 'cancelled');
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 0, tasks: 3 });
  });

  it('sums across multiple orgs', () => {
    writeApproval('acme', 'a1');
    writeApproval('other-org', 'a2');
    writeTask('acme', 't1', 'pending');
    writeTask('other-org', 't2', 'in_progress');
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 2, tasks: 2 });
  });

  it('ignores a malformed task JSON file instead of throwing', () => {
    const dir = join(ctxRoot, 'orgs', 'acme', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'corrupt.json'), 'not valid json{{{');
    writeTask('acme', 'task_ok', 'pending');
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 0, tasks: 1 });
  });

  it('ignores non-.json files in approvals/pending and tasks', () => {
    const approvalsDir = join(ctxRoot, 'orgs', 'acme', 'approvals', 'pending');
    mkdirSync(approvalsDir, { recursive: true });
    writeFileSync(join(approvalsDir, '.gitkeep'), '');
    writeApproval('acme', 'a1');
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 1, tasks: 0 });
  });

  it('resolved approvals do not count (only approvals/pending is checked)', () => {
    const resolvedDir = join(ctxRoot, 'orgs', 'acme', 'approvals', 'resolved');
    mkdirSync(resolvedDir, { recursive: true });
    writeFileSync(join(resolvedDir, 'approval_1.json'), JSON.stringify({ id: 'approval_1', status: 'approved' }));
    expect(countPendingState(ctxRoot)).toEqual({ approvals: 0, tasks: 0 });
  });
});
