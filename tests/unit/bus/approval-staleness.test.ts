/**
 * Regression tests for approval staleness (evening-review backlog proposal,
 * 2026-07-29): a pending approval has no auto-expiry by design, so an aging
 * approval blocking real work is otherwise invisible until someone manually
 * diffs created_at against "now" via list-approvals. isApprovalStale gives
 * that a first-class, testable signal. Mirrors isStatusStringStale's shape
 * (tests/unit/bus/heartbeat-status-staleness.test.ts) for consistency.
 */
import { describe, it, expect } from 'vitest';
import { isApprovalStale, DEFAULT_APPROVAL_STALE_MS } from '../../../src/bus/approval';

describe('isApprovalStale', () => {
  it('is false when created_at is recent', () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const recent = '2026-07-29T11:00:00Z'; // 1h ago
    expect(isApprovalStale({ created_at: recent }, DEFAULT_APPROVAL_STALE_MS, now)).toBe(false);
  });

  it('is true when created_at is past the threshold', () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const old = '2026-07-29T07:00:00Z'; // 5h ago, past the 4h default
    expect(isApprovalStale({ created_at: old }, DEFAULT_APPROVAL_STALE_MS, now)).toBe(true);
  });

  it('is false exactly at the threshold boundary minus a moment, true at/after it', () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const justUnder = new Date(now - DEFAULT_APPROVAL_STALE_MS + 1000).toISOString();
    const exact = new Date(now - DEFAULT_APPROVAL_STALE_MS).toISOString();
    expect(isApprovalStale({ created_at: justUnder }, DEFAULT_APPROVAL_STALE_MS, now)).toBe(false);
    expect(isApprovalStale({ created_at: exact }, DEFAULT_APPROVAL_STALE_MS, now)).toBe(true);
  });

  it('respects a custom threshold', () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const twoHoursAgo = '2026-07-29T10:00:00Z';
    expect(isApprovalStale({ created_at: twoHoursAgo }, 60 * 60 * 1000, now)).toBe(true); // 1h threshold
    expect(isApprovalStale({ created_at: twoHoursAgo }, 3 * 60 * 60 * 1000, now)).toBe(false); // 3h threshold
  });

  it('is false on an unparseable created_at rather than throwing', () => {
    expect(isApprovalStale({ created_at: 'not-a-date' })).toBe(false);
  });
});
