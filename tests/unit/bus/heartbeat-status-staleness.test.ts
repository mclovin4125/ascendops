/**
 * Regression tests for status-string staleness tracking (evening-review
 * backlog proposal, 2026-07-28): last_heartbeat proves an agent is
 * heartbeating on schedule, but the same status string repeated cycle after
 * cycle can mean it isn't reporting anything new. updateHeartbeat now tracks
 * status_since/status_repeat_count so that distinct signal is observable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { updateHeartbeat, isStatusStringStale, DEFAULT_STATUS_STALE_MS } from '../../../src/bus/heartbeat';
import type { BusPaths, Heartbeat } from '../../../src/types';

let testDir: string;
let paths: BusPaths;

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'collie'),
    inflight: join(root, 'inflight', 'collie'),
    processed: join(root, 'processed', 'collie'),
    logDir: join(root, 'logs', 'collie'),
    stateDir: join(root, 'state', 'collie'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
}

function readHb(): Heartbeat {
  return JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'));
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-status-stale-'));
  paths = makePaths(testDir);
  mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('updateHeartbeat — status_since / status_repeat_count tracking', () => {
  it('sets repeat_count=1 and status_since=now on the first ever heartbeat', () => {
    updateHeartbeat(paths, 'collie', 'online', { org: 'ascendops' });
    const hb = readHb();
    expect(hb.status_repeat_count).toBe(1);
    expect(hb.status_since).toBe(hb.last_heartbeat);
  });

  it('increments repeat_count and preserves the original status_since across repeats of the same status', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
      updateHeartbeat(paths, 'collie', 'watching for approvals', { org: 'ascendops' });
      const first = readHb();

      vi.setSystemTime(new Date('2026-07-28T12:00:05Z'));
      updateHeartbeat(paths, 'collie', 'watching for approvals', { org: 'ascendops' });
      const second = readHb();

      expect(second.status_repeat_count).toBe(2);
      expect(second.status_since).toBe(first.status_since);
      expect(second.last_heartbeat).not.toBe(first.last_heartbeat);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets repeat_count to 1 and bumps status_since when the status string changes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-28T12:00:00Z'));
      updateHeartbeat(paths, 'collie', 'watching for approvals', { org: 'ascendops' });

      vi.setSystemTime(new Date('2026-07-28T12:00:05Z'));
      updateHeartbeat(paths, 'collie', 'watching for approvals', { org: 'ascendops' });
      const repeated = readHb();
      expect(repeated.status_repeat_count).toBe(2);

      vi.setSystemTime(new Date('2026-07-28T12:00:10Z'));
      updateHeartbeat(paths, 'collie', 'merging approved fix', { org: 'ascendops' });
      const changed = readHb();
      expect(changed.status_repeat_count).toBe(1);
      expect(changed.status_since).toBe(changed.last_heartbeat);
      expect(changed.status_since).not.toBe(repeated.status_since);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a prior heartbeat.json with no status_since as fresh (backward compat), not stale', () => {
    // A heartbeat.json written before this field existed.
    updateHeartbeat(paths, 'collie', 'online', { org: 'ascendops' });
    const hb = readHb();
    delete (hb as Partial<Heartbeat>).status_since;
    delete (hb as Partial<Heartbeat>).status_repeat_count;
    writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(hb));

    updateHeartbeat(paths, 'collie', 'online', { org: 'ascendops' });
    const after = readHb();
    // Falls back to last_heartbeat as the origin point rather than crashing
    // or treating the missing field as "stale forever".
    expect(after.status_repeat_count).toBe(2);
    expect(after.status_since).toBe(hb.last_heartbeat);
  });
});

describe('isStatusStringStale', () => {
  it('is false when status_since is missing', () => {
    expect(isStatusStringStale({ status_since: undefined })).toBe(false);
  });

  it('is false when status_since is recent', () => {
    const now = Date.parse('2026-07-28T12:00:00Z');
    const recent = '2026-07-28T11:00:00Z'; // 1h ago
    expect(isStatusStringStale({ status_since: recent }, DEFAULT_STATUS_STALE_MS, now)).toBe(false);
  });

  it('is true when status_since is past the threshold', () => {
    const now = Date.parse('2026-07-28T12:00:00Z');
    const old = '2026-07-27T23:00:00Z'; // 13h ago, past the 12h default
    expect(isStatusStringStale({ status_since: old }, DEFAULT_STATUS_STALE_MS, now)).toBe(true);
  });

  it('is false on an unparseable status_since rather than throwing', () => {
    expect(isStatusStringStale({ status_since: 'not-a-date' })).toBe(false);
  });
});
