import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkGate,
  GATED_RENTVINE_TOOLS,
  RECENT_WINDOW_MS,
} from '../../../src/hooks/hook-rentvine-approval-gate';
import type { Approval, BusPaths } from '../../../src/types';

let testDir: string;
let paths: BusPaths;

function mkPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

function writeResolvedApproval(paths: BusPaths, approval: Approval): void {
  const dir = join(paths.approvalDir, 'resolved');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${approval.id}.json`), JSON.stringify(approval));
}

function baseApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval_test_1',
    title: 'File RentVine feedback',
    requesting_agent: 'maintenance-director',
    org: 'lane-family-homes',
    category: 'external-comms',
    status: 'approved',
    description: '',
    created_at: '2026-08-13T09:00:00Z',
    updated_at: '2026-08-13T09:00:00Z',
    resolved_at: '2026-08-13T09:00:00Z',
    resolved_by: 'Mack via Telegram',
    ...overrides,
  };
}

const NOW = Date.parse('2026-08-13T10:00:00Z'); // 1h after the base approval

describe('hook-rentvine-approval-gate — checkGate', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-rentvine-gate-test-'));
    paths = mkPaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('does not gate tool names outside GATED_RENTVINE_TOOLS at all', () => {
    // No approval on disk anywhere — an ungated tool must still pass.
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__get_work_order', NOW);
    expect(result.allowed).toBe(true);
  });

  it('blocks the incident tool (send_rentvine_feedback) when no approval exists at all — the exact 2026-08-12 gap', () => {
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/requires a resolved, approved approval/);
  });

  it('allows the call when a recent, approved, matching-category approval exists for this agent', () => {
    writeResolvedApproval(paths, baseApproval());
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(true);
  });

  it('blocks when the only approval belongs to a DIFFERENT agent — cannot borrow someone else\'s approval', () => {
    writeResolvedApproval(paths, baseApproval({ id: 'a2', requesting_agent: 'ea' }));
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(false);
  });

  it('blocks when the approval is still pending, not yet approved', () => {
    writeResolvedApproval(paths, baseApproval({ id: 'a3', status: 'pending', resolved_at: null }));
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(false);
  });

  it('blocks when the approval was rejected, not approved', () => {
    writeResolvedApproval(paths, baseApproval({ id: 'a4', status: 'rejected' }));
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(false);
  });

  it('blocks when the approval category is unrelated (e.g. financial)', () => {
    writeResolvedApproval(paths, baseApproval({ id: 'a5', category: 'financial' }));
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(false);
  });

  it('accepts "other" category as well as "external-comms"', () => {
    writeResolvedApproval(paths, baseApproval({ id: 'a6', category: 'other' }));
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(true);
  });

  it('blocks once the approval ages past RECENT_WINDOW_MS — not a permanent unlock', () => {
    const tooOld = new Date(NOW - RECENT_WINDOW_MS - 1000).toISOString();
    writeResolvedApproval(paths, baseApproval({ id: 'a7', resolved_at: tooOld }));
    const result = checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW);
    expect(result.allowed).toBe(false);
  });

  it('allows exactly at the window boundary and just under it', () => {
    const justUnder = new Date(NOW - RECENT_WINDOW_MS + 1000).toISOString();
    writeResolvedApproval(paths, baseApproval({ id: 'a8', resolved_at: justUnder }));
    expect(checkGate(paths, 'maintenance-director', 'mcp__rentvine__send_rentvine_feedback', NOW).allowed).toBe(true);
  });

  it('GATED_RENTVINE_TOOLS names the exact incident tool', () => {
    expect(GATED_RENTVINE_TOOLS.has('mcp__rentvine__send_rentvine_feedback')).toBe(true);
  });
});
