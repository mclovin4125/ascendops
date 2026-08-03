/**
 * fast-checker-suspend.test.ts — staleness watchdogs must not count time the
 * daemon was not running.
 *
 * Regression: on a Mac that idle-sleeps, macOS wakes on the ~53min
 * mDNSResponder DHCP maintenance timer. Node timers do not fire while the
 * machine is asleep, so on every wake Date.now() had jumped past every
 * staleness threshold at once and the pollCycle watchdog hard-restarted the
 * entire fleet. Observed: 103/103 WATCHDOG-HARD-RESTART entries landed within
 * ~5s of a system wake, all four agents at the same millisecond, all night.
 *
 * The fix banks wall-clock gaps during which the process was demonstrably not
 * scheduled and discounts them, so thresholds measure time the daemon was
 * actually alive to observe the agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths } from '../../../src/types';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

function createPaths(root: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
    deliverablesDir: join(root, 'deliverables'),
  };
  Object.values(paths).forEach((path) => mkdirSync(path, { recursive: true }));
  return paths;
}

function createAgent() {
  let lastInjectedAt = 0;
  return {
    name: 'member-agent',
    getStatus: vi.fn().mockReturnValue({ status: 'running' }),
    sessionRefresh: vi.fn().mockResolvedValue(undefined),
    injectMessage: vi.fn().mockReturnValue(true),
    injectMessageDetailed: vi.fn().mockReturnValue({ ok: true }),
    getLastInjectedAt: vi.fn(() => lastInjectedAt),
    setLastInjectedAt: (at: number) => { lastInjectedAt = at; },
  } as any;
}

const MIN = 60_000;
/** The DHCP-lease maintenance wake interval seen in the incident. */
const MAINTENANCE_SLEEP_MS = 3197 * 1000;

describe('suspend-aware staleness watchdogs', () => {
  let root: string;
  let paths: BusPaths;
  const now = new Date('2026-08-03T04:00:00.000Z').getTime();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    root = mkdtempSync(join(tmpdir(), 'fastchecker-suspend-'));
    paths = createPaths(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  function createChecker(agent: ReturnType<typeof createAgent>, thresholdMinutes = 30): any {
    const checker = new FastChecker(agent, paths, '/framework', {
      turnWatchdogThresholdMinutes: thresholdMinutes,
      log: vi.fn(),
    } as any) as any;
    checker.bootstrappedAt = now - 48 * 60 * 60_000;
    checker.sessionStartedAt = Date.now() - 1_000;
    writeFileSync(join(paths.logDir, 'stdout.log'), '');
    checker.watchdogCheck(); // Seed the incremental stdout cursor.
    checker.noteLiveness();  // Seed the suspend detector, as start() does.
    return checker;
  }

  function armWatchdog(checker: any, idleAt = Date.now() - 48 * 60 * 60_000): void {
    const flagPath = join(paths.stateDir, 'last_idle.flag');
    writeFileSync(flagPath, String(Math.floor(idleAt / 1000)));
    const observedAt = new Date(checker.sessionStartedAt + 1);
    utimesSync(flagPath, observedAt, observedAt);
    checker.watchdogCheck();
  }

  /** Advance the clock the way a running process experiences it: in ticks. */
  function elapseWhileRunning(checker: any, totalMs: number, stepMs = 25_000): void {
    const target = Date.now() + totalMs;
    while (Date.now() + stepMs < target) {
      vi.setSystemTime(Date.now() + stepMs);
      checker.noteLiveness();
    }
    vi.setSystemTime(target);
    checker.noteLiveness();
  }

  /** Advance the clock the way a suspended process experiences it: one jump. */
  function elapseWhileSuspended(checker: any, totalMs: number): void {
    vi.setSystemTime(Date.now() + totalMs);
    checker.noteLiveness(); // The first timer to fire after wake.
  }

  describe('suspend accounting', () => {
    it('with no suspend, running elapsed equals the wall-clock delta', () => {
      const checker = createChecker(createAgent());
      const baseline = Date.now();
      elapseWhileRunning(checker, 10 * MIN);
      expect(checker.runningElapsedSince(baseline, Date.now())).toBe(10 * MIN);
    });

    it('discounts a maintenance-wake sleep: a 3197s jump is ~0s of running time', () => {
      const checker = createChecker(createAgent());
      const baseline = Date.now();
      elapseWhileSuspended(checker, MAINTENANCE_SLEEP_MS);

      const stall = checker.runningElapsedSince(baseline, Date.now());
      // Only the one un-banked tick's worth remains — nowhere near the 90s
      // pollCycle stall threshold that fired 103 times overnight.
      expect(stall).toBeLessThanOrEqual(checker.LIVENESS_TICK_MS);
      expect(stall).toBeLessThan(90_000);
    });

    it('ignores tick jitter below the tolerance', () => {
      const checker = createChecker(createAgent());
      const baseline = Date.now();
      for (let i = 0; i < 20; i += 1) {
        vi.setSystemTime(Date.now() + 20_000); // late, but plausibly scheduled
        checker.noteLiveness();
      }
      expect(checker.suspendEvents).toHaveLength(0);
      expect(checker.runningElapsedSince(baseline, Date.now())).toBe(20 * 20_000);
    });

    it('still measures real stall accrued after a suspend', () => {
      const checker = createChecker(createAgent());
      const baseline = Date.now();
      elapseWhileSuspended(checker, MAINTENANCE_SLEEP_MS);
      elapseWhileRunning(checker, 5 * MIN);

      // The sleep is discounted; the 5 minutes awake are not.
      const stall = checker.runningElapsedSince(baseline, Date.now());
      expect(stall).toBeGreaterThanOrEqual(5 * MIN);
      expect(stall).toBeLessThanOrEqual(5 * MIN + checker.LIVENESS_TICK_MS);
    });

    it('does not discount a suspend that ended before the baseline', () => {
      const checker = createChecker(createAgent());
      elapseWhileSuspended(checker, MAINTENANCE_SLEEP_MS);
      // Baseline taken after waking — the sleep is not this baseline's concern.
      const baseline = Date.now();
      elapseWhileRunning(checker, 10 * MIN);
      expect(checker.runningElapsedSince(baseline, Date.now())).toBe(10 * MIN);
    });

    it('discounts only the part of a suspend that overlaps the baseline window', () => {
      const checker = createChecker(createAgent());
      // Baseline sits 60s into what will become a 600s unscheduled gap.
      vi.setSystemTime(Date.now() + 60_000);
      const baseline = Date.now();
      vi.setSystemTime(Date.now() + 540_000);
      checker.noteLiveness();

      // Suspension banked is (600s - one tick), of which 540s postdates the
      // baseline, so ~60s of the gap is still charged as running time.
      const stall = checker.runningElapsedSince(baseline, Date.now());
      expect(stall).toBeGreaterThanOrEqual(0);
      expect(stall).toBeLessThanOrEqual(60_000);
    });

    it('banks nothing when the clock steps backwards (NTP correction)', () => {
      const checker = createChecker(createAgent());
      vi.setSystemTime(Date.now() - 5 * MIN);
      checker.noteLiveness();
      expect(checker.suspendEvents).toHaveLength(0);
    });

    it('prunes banked suspends older than the longest watchdog window', () => {
      const checker = createChecker(createAgent());
      elapseWhileSuspended(checker, MAINTENANCE_SLEEP_MS);
      expect(checker.suspendEvents).toHaveLength(1);

      elapseWhileSuspended(checker, 7 * 60 * MIN); // 7h — past the 6h window
      // The new event is retained; the stale one is dropped.
      expect(checker.suspendEvents).toHaveLength(1);
      expect(checker.suspendEvents[0].endedAt).toBe(Date.now());
    });
  });

  describe('turn watchdog', () => {
    it('does not fire when the threshold is crossed only by machine sleep', () => {
      const agent = createAgent();
      const checker = createChecker(agent, 30);
      armWatchdog(checker);
      agent.setLastInjectedAt(Date.now() - 1 * MIN); // turn opened a minute ago

      elapseWhileSuspended(checker, MAINTENANCE_SLEEP_MS); // 53min asleep
      checker.watchdogCheck();

      expect(agent.sessionRefresh).not.toHaveBeenCalled();
      expect(checker.turnHung).toBe(false);
    });

    it('still fires when the same time passes with the daemon awake', () => {
      const agent = createAgent();
      const checker = createChecker(agent, 30);
      armWatchdog(checker);
      agent.setLastInjectedAt(Date.now() - 1 * MIN);

      elapseWhileRunning(checker, MAINTENANCE_SLEEP_MS); // 53min awake, no output
      checker.watchdogCheck();

      expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
      expect(checker.turnHung).toBe(true);
    });

    it('fires once the stall is real, even if a sleep happened first', () => {
      const agent = createAgent();
      const checker = createChecker(agent, 30);
      armWatchdog(checker);
      agent.setLastInjectedAt(Date.now() - 1 * MIN);

      elapseWhileSuspended(checker, MAINTENANCE_SLEEP_MS);
      checker.watchdogCheck();
      expect(agent.sessionRefresh).not.toHaveBeenCalled();

      // Awake and still producing nothing — protection is deferred, not lost.
      elapseWhileRunning(checker, 31 * MIN);
      checker.watchdogCheck();
      expect(agent.sessionRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
