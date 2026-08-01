/**
 * tests/unit/bus/shift-config.test.ts
 *
 * Covers the quiet-hours writer used by `cortextos bus set-shift`.
 *
 * The assertions that matter most are the strand-detection ones. When the
 * daemon suppresses a cron fire off-shift it returns NORMALLY — fireWithRetry
 * records a success and advances nextFireAt by a full period. So a daily cron
 * whose slot falls outside the window is not skipped once, it is suppressed at
 * that same wall-clock time every day thereafter, with no error anywhere. A
 * careless window edit can therefore silently kill a cron, and these tests pin
 * the guard that makes that impossible by accident.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseDayShift,
  buildShiftSchedule,
  findStrandedCrons,
  applyShiftSchedule,
  type AgentConfigShape,
} from '../../../src/bus/shift-config.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cortextos-shift-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeConfig(config: AgentConfigShape, trailingNewline = true): string {
  mkdirSync(join(dir, 'alice'), { recursive: true });
  const p = join(dir, 'alice', 'config.json');
  writeFileSync(p, JSON.stringify(config, null, 2) + (trailingNewline ? '\n' : ''), 'utf-8');
  return p;
}

describe('parseDayShift', () => {
  it('parses a window, off, and 24h', () => {
    expect(parseDayShift('08:00-22:00')).toEqual({ start: '08:00', end: '22:00' });
    expect(parseDayShift('off')).toBe('off');
    expect(parseDayShift('24H')).toBe('24h');
  });

  it('accepts a midnight-crossing window', () => {
    // isInWindow handles start > end as the wrap-around branch.
    expect(parseDayShift('22:00-06:00')).toEqual({ start: '22:00', end: '06:00' });
  });

  it.each(['', 'nonsense', '8:00-22:00', '08:00', '25:00-26:00', '08:00_22:00'])(
    'rejects malformed spec %j',
    (spec) => {
      // A malformed window must never silently degrade to "off" — that would
      // suppress every cron for that day.
      expect(() => parseDayShift(spec)).toThrow();
    },
  );

  it('rejects an identical start and end rather than silently meaning "never"', () => {
    // isInWindow takes the same-day branch when start <= end, where
    // `t >= start && t < end` can never be true — i.e. always off-shift.
    expect(() => parseDayShift('08:00-08:00')).toThrow(/identical/i);
  });
});

describe('buildShiftSchedule', () => {
  it('spreads weekday and weekend specs across all seven days', () => {
    const s = buildShiftSchedule('08:00-22:00', 'off');
    expect(s.weekly.mon).toEqual({ start: '08:00', end: '22:00' });
    expect(s.weekly.fri).toEqual({ start: '08:00', end: '22:00' });
    expect(s.weekly.sat).toBe('off');
    expect(s.weekly.sun).toBe('off');
    expect(Object.keys(s.weekly)).toHaveLength(7);
  });
});

describe('findStrandedCrons', () => {
  const config: AgentConfigShape = {
    crons: [
      { name: 'morning-review', cron: '0 8 * * *' },
      { name: 'evening-review', cron: '0 18 * * *' },
      { name: 'weekly-review', cron: '0 8 * * 0' },
      { name: 'heartbeat', interval: '4h' },
      { name: 'auto-commit', interval: '24h' },
      { name: 'nightly-metrics', interval: '24h', wake_on_fire: true },
    ],
  };

  it('reports nothing when every anchored cron fits the window', () => {
    const report = findStrandedCrons(config, buildShiftSchedule('08:00-22:00', '08:00-21:00'));
    expect(report.stranded).toEqual([]);
  });

  it('catches the exclusive-end off-by-one', () => {
    // The window end is EXCLUSIVE (shift.ts isInWindow), so an 18:00 cron
    // against an 18:00 end is suppressed — the exact bug that shipped in the
    // first draft of the template weekend windows.
    const report = findStrandedCrons(config, buildShiftSchedule('08:00-22:00', '08:00-18:00'));
    expect(report.stranded.some((s) => s.startsWith('evening-review'))).toBe(true);
    // Weekdays are unaffected at 08:00-22:00, so only the two weekend days fire.
    expect(report.stranded.filter((s) => s.startsWith('evening-review'))).toHaveLength(2);
  });

  it('catches a day-of-week-anchored cron on an off day', () => {
    const report = findStrandedCrons(config, buildShiftSchedule('08:00-22:00', 'off'));
    expect(report.stranded.some((s) => s.startsWith('weekly-review'))).toBe(true);
  });

  it('never reports a wake_on_fire cron — it bypasses the gate by design', () => {
    const report = findStrandedCrons(config, buildShiftSchedule('08:00-22:00', 'off'));
    expect(report.stranded.join()).not.toContain('nightly-metrics');
    expect(report.atRisk.join()).not.toContain('nightly-metrics');
  });

  it('flags long-period interval crons as at-risk but not short ones', () => {
    const report = findStrandedCrons(config, buildShiftSchedule('08:00-22:00', '08:00-21:00'));
    expect(report.atRisk.some((s) => s.startsWith('auto-commit'))).toBe(true);
    // A 4h cron cycles through the window every day, so it cannot strand.
    expect(report.atRisk.join()).not.toContain('heartbeat');
  });

  it('reports an unparseable cron expression instead of silently passing it', () => {
    const odd: AgentConfigShape = { crons: [{ name: 'weird', cron: '*/7 3-5 1 * *' }] };
    const report = findStrandedCrons(odd, buildShiftSchedule('08:00-22:00', '08:00-21:00'));
    expect(report.unanalyzed).toHaveLength(1);
    expect(report.stranded).toEqual([]);
  });
});

describe('applyShiftSchedule', () => {
  it('writes the schedule and places it next to timezone', () => {
    const p = writeConfig({ timezone: 'America/New_York', crons: [{ name: 'heartbeat', interval: '4h' }] });
    const schedule = buildShiftSchedule('08:00-22:00', '08:00-21:00');

    const result = applyShiftSchedule('alice', p, schedule);

    expect(result.action).toBe('set');
    const written = JSON.parse(readFileSync(p, 'utf-8'));
    expect(written.shift_schedule).toEqual(schedule);
    expect(Object.keys(written)).toEqual(['timezone', 'shift_schedule', 'crons']);
  });

  it('does not write on a dry run', () => {
    const p = writeConfig({ timezone: 'UTC' });
    const before = readFileSync(p, 'utf-8');

    const result = applyShiftSchedule('alice', p, buildShiftSchedule('08:00-22:00', 'off'), { dryRun: true });

    expect(result.action).toBe('set');
    expect(readFileSync(p, 'utf-8')).toBe(before);
  });

  it('reports unchanged when the schedule already matches', () => {
    const schedule = buildShiftSchedule('08:00-22:00', '08:00-21:00');
    const p = writeConfig({ timezone: 'UTC', shift_schedule: schedule });

    expect(applyShiftSchedule('alice', p, schedule).action).toBe('unchanged');
  });

  it('clears the field when passed null, restoring 24/7', () => {
    const p = writeConfig({ timezone: 'UTC', shift_schedule: buildShiftSchedule('08:00-22:00', 'off') });

    const result = applyShiftSchedule('alice', p, null);

    expect(result.action).toBe('cleared');
    expect(JSON.parse(readFileSync(p, 'utf-8')).shift_schedule).toBeUndefined();
  });

  it('skips hermes agents without writing', () => {
    // startAgentCronScheduler() returns early for hermes, so the shift gate
    // never runs — a schedule there would read as protection it does not give.
    const p = writeConfig({ runtime: 'hermes', timezone: 'UTC' });
    const before = readFileSync(p, 'utf-8');

    const result = applyShiftSchedule('alice', p, buildShiftSchedule('08:00-22:00', 'off'));

    expect(result.action).toBe('skipped-hermes');
    expect(readFileSync(p, 'utf-8')).toBe(before);
  });

  it('preserves every other config field and the trailing newline', () => {
    const p = writeConfig({
      timezone: 'UTC',
      runtime: 'claude-code',
      crons: [{ name: 'heartbeat', interval: '4h' }],
    } as AgentConfigShape);

    applyShiftSchedule('alice', p, buildShiftSchedule('08:00-22:00', '08:00-21:00'));

    const raw = readFileSync(p, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const written = JSON.parse(raw);
    expect(written.runtime).toBe('claude-code');
    expect(written.crons).toHaveLength(1);
  });

  it('surfaces the strand report alongside the write decision', () => {
    const p = writeConfig({ timezone: 'UTC', crons: [{ name: 'evening-review', cron: '0 18 * * *' }] });

    const result = applyShiftSchedule('alice', p, buildShiftSchedule('08:00-17:00', '08:00-17:00'), { dryRun: true });

    expect(result.strand.stranded.length).toBeGreaterThan(0);
  });
});
