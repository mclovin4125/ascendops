/**
 * shift-config.ts — read/write the per-agent `shift_schedule` in config.json.
 *
 * `shift_schedule` is the daemon's only real quiet-hours gate: AgentManager's
 * evaluateCronShiftSuppression() feeds it to evaluateShift() and drops cron
 * fires that land off-shift. (`day_mode_start` / `day_mode_end` are prose-only —
 * interpolated into IDENTITY.md and printed by `bus get-config`, but read by no
 * daemon code path.) Shipped templates now seed a schedule, but templates only
 * apply to newly-created agents; this module is how an existing fleet gets one.
 *
 * The important safety property here is strand detection. When a cron fire is
 * suppressed off-shift the daemon returns NORMALLY — fireWithRetry records a
 * success and advances nextFireAt by a full period. So a daily cron whose slot
 * falls outside the new window is not "skipped once": it is suppressed at that
 * same wall-clock time every day thereafter, silently, with no error anywhere.
 * A window edit is therefore capable of quietly killing a cron, and
 * findStrandedCrons() exists so that can never happen by accident.
 */

import { readFileSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';
import { evaluateShift, type DayShift, type ShiftSchedule, type WeekdayKey } from '../daemon/shift.js';

export const WEEKDAY_KEYS: WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const WEEKEND_KEYS: WeekdayKey[] = ['sat', 'sun'];

/** Crons at or above this period re-schedule to the same wall-clock slot after a
 *  suppressed fire, so one off-shift landing strands them permanently. */
const STRANDING_RISK_MS = 24 * 60 * 60 * 1000;

export interface AgentConfigShape {
  runtime?: string;
  timezone?: string;
  shift_schedule?: ShiftSchedule;
  crons?: Array<{
    name: string;
    interval?: string;
    cron?: string;
    wake_on_fire?: boolean;
  }>;
}

/**
 * Parse a day-shift spec: "HH:MM-HH:MM", "off", or "24h".
 * Throws on anything else — a malformed window must never silently become
 * "off", which would suppress every cron for that day.
 */
export function parseDayShift(spec: string): DayShift {
  const s = spec.trim().toLowerCase();
  if (s === 'off') return 'off';
  if (s === '24h') return '24h';

  const m = /^([0-2]\d:[0-5]\d)-([0-2]\d:[0-5]\d)$/.exec(s);
  if (!m) {
    throw new Error(`Invalid shift spec "${spec}". Expected "HH:MM-HH:MM", "off", or "24h".`);
  }
  const [, start, end] = m;
  for (const t of [start, end]) {
    if (Number(t.slice(0, 2)) > 23) throw new Error(`Invalid hour in "${spec}" (00-23).`);
  }
  if (start === end) {
    // start === end is genuinely ambiguous under isInWindow (start <= end takes
    // the same-day branch and `t >= start && t < end` is never true), so it
    // would silently mean "always off". Reject rather than surprise.
    throw new Error(`Invalid shift spec "${spec}": start and end are identical. Use "24h" for all-day or "off" for no shift.`);
  }
  return { start, end };
}

/** Build a full weekly schedule from a weekday spec and a weekend spec. */
export function buildShiftSchedule(weekdaySpec: string, weekendSpec: string): ShiftSchedule {
  const weekday = parseDayShift(weekdaySpec);
  const weekend = parseDayShift(weekendSpec);
  const weekly = {} as Record<WeekdayKey, DayShift>;
  for (const k of WEEKDAY_KEYS) weekly[k] = weekday;
  for (const k of WEEKEND_KEYS) weekly[k] = weekend;
  return { weekly };
}

function intervalMs(interval: string): number {
  const m = /^(\d+)([smhd])$/.exec(interval.trim());
  if (!m) return NaN;
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/**
 * Expand a 5-field cron expression into representative firing instants — one
 * per matching day-of-week. Only the shapes real configs use are handled
 * (literal minute + literal hour; `*` or comma-list day-of-week). Anything
 * else returns [] and is reported separately as unanalyzable.
 */
function firingsFor(expr: string): Array<{ date: Date; label: string }> | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, , , dow] = parts;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  if (dow !== '*' && !/^\d(,\d)*$/.test(dow)) return null;

  const dows = dow === '*' ? [0, 1, 2, 3, 4, 5, 6] : dow.split(',').map(Number);
  // 2026-06-07 is a Sunday, so adding the cron dow lands on the right weekday.
  return dows.map((d) => ({
    date: new Date(Date.UTC(2026, 5, 7 + d, Number(hour), Number(minute))),
    label: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')} dow=${d}`,
  }));
}

export interface StrandReport {
  /** Time-anchored crons that would fall outside the new window. */
  stranded: string[];
  /** Long-period interval crons that could strand depending on fire phase. */
  atRisk: string[];
  /** Cron expressions this checker could not analyze — review by hand. */
  unanalyzed: string[];
}

/**
 * Report crons that the given schedule would suppress permanently.
 * `wake_on_fire` crons bypass the gate by design and are never reported.
 */
export function findStrandedCrons(config: AgentConfigShape, schedule: ShiftSchedule): StrandReport {
  const report: StrandReport = { stranded: [], atRisk: [], unanalyzed: [] };
  // Evaluate in UTC so the answer is about the window arithmetic itself. The
  // cron expressions and the window are both written in the agent's own local
  // wall-clock, so comparing them in a single fixed zone is the correct check.
  const tz = 'UTC';

  for (const cron of config.crons ?? []) {
    if (cron.wake_on_fire) continue;

    if (cron.cron) {
      const firings = firingsFor(cron.cron);
      if (firings === null) {
        report.unanalyzed.push(`${cron.name} (${cron.cron})`);
        continue;
      }
      for (const { date, label } of firings) {
        if (!evaluateShift(date, schedule, tz).in_shift) {
          report.stranded.push(`${cron.name} (${cron.cron}) at ${label}`);
        }
      }
      continue;
    }

    if (cron.interval) {
      const ms = intervalMs(cron.interval);
      if (Number.isFinite(ms) && ms >= STRANDING_RISK_MS) {
        report.atRisk.push(`${cron.name} (${cron.interval})`);
      }
    }
  }

  return report;
}

export interface ApplyResult {
  agent: string;
  configPath: string;
  /** 'set' | 'cleared' | 'unchanged' | 'skipped-hermes' */
  action: 'set' | 'cleared' | 'unchanged' | 'skipped-hermes';
  previous: ShiftSchedule | null;
  next: ShiftSchedule | null;
  strand: StrandReport;
  /** True when nothing was written (dry run, or no change needed). */
  dryRun: boolean;
}

/**
 * Apply (or clear) a shift schedule on one agent's config.json.
 *
 * Pass `schedule: null` to remove the field, restoring the daemon's 24/7
 * default. Returns without writing when `dryRun` is set, or when the config
 * already holds an identical schedule.
 *
 * Hermes agents are skipped: startAgentCronScheduler() returns early for them,
 * so the daemon shift gate never runs and a schedule there would be inert
 * config that reads as protection it does not provide.
 */
export function applyShiftSchedule(
  agent: string,
  configPath: string,
  schedule: ShiftSchedule | null,
  opts: { dryRun?: boolean } = {},
): ApplyResult {
  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as AgentConfigShape;
  const previous = config.shift_schedule ?? null;
  const dryRun = opts.dryRun ?? false;

  const base: Omit<ApplyResult, 'action'> = {
    agent,
    configPath,
    previous,
    next: schedule,
    strand: schedule ? findStrandedCrons(config, schedule) : { stranded: [], atRisk: [], unanalyzed: [] },
    dryRun,
  };

  if (config.runtime === 'hermes') {
    return { ...base, action: 'skipped-hermes', next: previous, dryRun: true };
  }

  if (JSON.stringify(previous) === JSON.stringify(schedule)) {
    return { ...base, action: 'unchanged', dryRun: true };
  }

  if (!dryRun) {
    // Rebuild the object so `shift_schedule` lands next to `timezone` on a
    // first write instead of being appended after the crons array.
    const out: Record<string, unknown> = {};
    let placed = false;
    for (const [k, v] of Object.entries(config)) {
      if (k === 'shift_schedule') {
        if (schedule) { out[k] = schedule; placed = true; }
        continue; // dropping the key is how `--clear` works
      }
      out[k] = v;
      if (k === 'timezone' && schedule && !placed) { out.shift_schedule = schedule; placed = true; }
    }
    if (schedule && !placed) out.shift_schedule = schedule;

    const trailing = raw.endsWith('\n') ? '\n' : '';
    atomicWriteSync(configPath, JSON.stringify(out, null, 2) + trailing, /* keepBak */ true);
  }

  return { ...base, action: schedule ? 'set' : 'cleared' };
}
