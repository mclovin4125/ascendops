/**
 * tests/integration/shipped-configs-quiet-hours.test.ts
 *
 * Regression guard for the overnight-boot work.
 *
 * Background: `shift_schedule` is the daemon's only real quiet-hours gate
 * (evaluated in AgentManager.evaluateCronShiftSuppression via evaluateShift).
 * `day_mode_start` / `day_mode_end` are prose-only — they are interpolated into
 * IDENTITY.md and printed by `bus get-config`, but no daemon code path reads
 * them. No shipped config used to set `shift_schedule`, so evaluateShift() saw
 * `undefined` and returned in_shift for every agent, around the clock: the
 * 4-hourly "work on your highest priority task" heartbeat fired at 02:00 and
 * 06:00 like any other hour.
 *
 * This file asserts the shipped configs stay quiet overnight, and — just as
 * importantly — that no shift window silently strangles a cron that has to run.
 *
 * Two failure modes it guards against:
 *
 *   1. A config with crons but no shift_schedule → 24/7 overnight work.
 *
 *   2. A time-anchored cron ("0 18 * * *") that falls OUTSIDE its own agent's
 *      window. The suppression path in the daemon returns normally, so
 *      fireWithRetry records a SUCCESS and advances nextFireAt by a full
 *      period — a daily cron suppressed once is suppressed at the same
 *      wall-clock time every day after, forever, without ever erroring. Note
 *      the window end is EXCLUSIVE (shift.ts isInWindow), so an 18:00 cron
 *      needs a window ending strictly after 18:00.
 *
 * Crons whose whole purpose is unattended off-hours execution carry
 * `wake_on_fire: true` and are exempt from check 2 by design.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { evaluateShift, type ShiftSchedule } from '../../src/daemon/shift.js';

// Long-period crons re-schedule to the same wall-clock slot after a suppressed
// fire, so a single off-shift landing strands them permanently. Anything at or
// above this period must therefore be explicitly wake_on_fire.
const STRANDING_RISK_MS = 24 * 60 * 60 * 1000;

interface CronEntryShape {
  name: string;
  interval?: string;
  cron?: string;
  wake_on_fire?: boolean;
}

interface ConfigShape {
  runtime?: string;
  crons?: CronEntryShape[];
  shift_schedule?: ShiftSchedule;
}

/** Recursively collect every config.json under `root` (fs.globSync is Node 22+). */
function findConfigs(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) findConfigs(full, out);
    else if (entry.name === 'config.json') out.push(relative(process.cwd(), full));
  }
  return out;
}

function shippedConfigs(): Array<{ path: string; config: ConfigShape }> {
  const paths = [
    ...findConfigs(join(process.cwd(), 'templates')),
    ...findConfigs(join(process.cwd(), 'community', 'agents')),
  ].sort();

  return paths
    .map((rel) => ({
      path: rel,
      config: JSON.parse(readFileSync(join(process.cwd(), rel), 'utf-8')) as ConfigShape,
    }))
    // Only configs that actually schedule work are in scope. Minimal role stubs
    // (name/runtime/model) and experiments/config.json carry no crons.
    .filter(({ config }) => Array.isArray(config.crons) && config.crons.length > 0)
    // Hermes schedules its crons natively; startAgentCronScheduler() returns
    // early for it, so the daemon shift gate never runs and a shift_schedule
    // there would be inert config that reads as protection it does not provide.
    .filter(({ config }) => config.runtime !== 'hermes');
}

function intervalMs(interval: string): number {
  const m = /^(\d+)([smhd])$/.exec(interval.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/**
 * Build the next Date matching a cron expression's minute/hour on the given
 * day-of-week. Only the shapes shipped configs actually use are handled:
 * literal minute + literal hour, `*` or a comma-list for day-of-week.
 */
function firingsFor(expr: string): Array<{ date: Date; label: string }> {
  const [minute, hour, , , dow] = expr.trim().split(/\s+/);
  const dows = dow === '*' ? [0, 1, 2, 3, 4, 5, 6] : dow.split(',').map((d) => Number(d));

  // 2026-06-07 is a Sunday, so adding the cron dow lands on the right weekday.
  return dows.map((d) => ({
    date: new Date(Date.UTC(2026, 5, 7 + d, Number(hour), Number(minute))),
    label: `dow=${d} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
  }));
}

describe('shipped agent configs — overnight quiet hours', () => {
  it('finds the shipped configs (guards against a silently-empty sweep)', () => {
    expect(shippedConfigs().length).toBeGreaterThan(10);
  });

  it.each(shippedConfigs())('$path declares a shift_schedule', ({ config }) => {
    // Without this, evaluateShift() returns in_shift unconditionally and every
    // cron below fires around the clock.
    expect(config.shift_schedule).toBeDefined();
    expect(config.shift_schedule?.weekly).toBeDefined();
  });

  it.each(shippedConfigs())(
    '$path keeps every time-anchored cron inside its own shift window',
    ({ config }) => {
      const schedule = config.shift_schedule;
      const stranded: string[] = [];

      for (const cron of config.crons ?? []) {
        if (cron.wake_on_fire) continue; // bypasses the gate by design
        if (!cron.cron) continue;

        for (const { date, label } of firingsFor(cron.cron)) {
          // Templates ship `timezone: ""`, which the daemon resolves to
          // America/New_York. Evaluate in UTC so the assertion is about the
          // window arithmetic, not the host's clock.
          if (!evaluateShift(date, schedule, 'UTC').in_shift) {
            stranded.push(`${cron.name} (${cron.cron}) at ${label}`);
          }
        }
      }

      expect(stranded).toEqual([]);
    },
  );

  it.each(shippedConfigs())(
    '$path marks stranding-risk interval crons as wake_on_fire',
    ({ config }) => {
      const unflagged = (config.crons ?? [])
        .filter((c) => c.interval && !c.wake_on_fire)
        .filter((c) => {
          const ms = intervalMs(c.interval!);
          return Number.isFinite(ms) && ms >= STRANDING_RISK_MS;
        })
        .map((c) => `${c.name} (${c.interval})`);

      expect(unflagged).toEqual([]);
    },
  );

  it('actually silences the heartbeat cron overnight', () => {
    // The end-to-end point of the whole change: the 4-hourly heartbeat prompt
    // ("work on your highest priority task") must not fire at 03:00.
    const { config } = shippedConfigs().find((c) => c.path === 'templates/agent/config.json')!;
    const heartbeat = config.crons!.find((c) => c.name === 'heartbeat')!;

    expect(heartbeat.wake_on_fire).toBeFalsy();
    expect(
      evaluateShift(new Date(Date.UTC(2026, 5, 9, 3, 0)), config.shift_schedule, 'UTC').in_shift,
    ).toBe(false);
    // ...and is wide awake during the working day.
    expect(
      evaluateShift(new Date(Date.UTC(2026, 5, 9, 14, 0)), config.shift_schedule, 'UTC').in_shift,
    ).toBe(true);
  });
});
