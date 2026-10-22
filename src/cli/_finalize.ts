// Drain-safe process exit for the one-shot CLI.
//
// Node 25 keeps an inherited socket/pipe stdin handle ref'd, so a bus command
// that finishes its work but does not call process.exit() itself will not exit
// naturally — it blocks until stdin reaches EOF. In the agent runtime stdin is
// a unix socket the parent PTY holds open for an unpredictable time, which was
// the intermittent "bus command hangs" bug. process.stdin.unref() is not
// reliable for an inherited socket stdin on Node 25, so we force the exit.
//
// A bare process.exit() would re-introduce the classic footgun of truncating
// un-flushed piped stdout, so we drain stdout/stderr first and only then exit,
// with a safety-net timeout so a pathologically slow consumer can never hang us
// indefinitely.
//
// Dependencies are injected so the drain-before-exit invariant is unit-testable
// without actually terminating the test process.

import { fstatSync } from 'fs';

export interface WritableLike {
  writableLength: number;
  write(chunk: string, cb: () => void): unknown;
}

export interface StdinLike {
  pause(): unknown;
  unref(): unknown;
}

export interface TimerLike {
  unref?: () => void;
}

export interface FinalizeDeps {
  stdout: WritableLike;
  stderr: WritableLike;
  stdin: StdinLike;
  exit: (code: number) => void;
  setExitCode: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => TimerLike;
}

// Safety-net: never block longer than this even if a consumer never drains.
export const DRAIN_TIMEOUT_MS = 1000;

export function finalize(code: number, deps: FinalizeDeps): void {
  deps.setExitCode(code);

  // Stop stdin from keeping the event loop alive (belt-and-suspenders; the
  // explicit exit below is what actually guarantees termination on Node 25).
  try {
    deps.stdin.pause();
    deps.stdin.unref();
  } catch {
    /* stdin may already be closed/destroyed — non-fatal */
  }

  let pending = 0;
  const exitNow = (): void => deps.exit(code);

  const drain = (stream: WritableLike): void => {
    // writableLength > 0 means Node still has buffered bytes not yet handed to
    // the OS; wait for the flush callback before exiting to avoid truncation.
    if (stream.writableLength === 0) return;
    pending++;
    stream.write('', () => {
      if (--pending === 0) exitNow();
    });
  };

  drain(deps.stdout);
  drain(deps.stderr);

  if (pending === 0) {
    exitNow();
    return;
  }

  const timer = deps.setTimer(exitNow, DRAIN_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// Opt-out for commands that intentionally keep the process alive.
//
// The drain-safe forced exit is correct for one-shot commands (all of `bus`,
// status, doctor, etc.), but a few commands deliberately stay attached to a
// long-lived child and must NOT be force-exited — currently only
// `start --foreground`, which spawns the daemon with inherited stdio and an
// `process.on('exit', () => child.kill())` handler, then returns to stay alive.
// (dashboard/tunnel/bot/workers/ecosystem are one-shot or use detached+unref,
// so they are intentionally fine with the forced exit.) Such a command calls
// requestKeepAlive() in its action; finalizeProcess() then becomes a no-op.
let keepAlive = false;

export function requestKeepAlive(): void {
  keepAlive = true;
}

export function shouldKeepAlive(): boolean {
  return keepAlive;
}

// Test-only: reset module state between cases.
export function resetKeepAlive(): void {
  keepAlive = false;
}

// A bus command run from a shell `while read ... < file` loop shares fd 0
// with the parent's `read` builtin for the life of the loop. The Node-25 hang
// this file guards against only happens with an inherited socket/pipe handle
// (the daemon's PTY case); touching process.stdin for a plain file does
// nothing useful and was observed breaking such loops (one bus invocation
// constructing/"peeking" the shared fd fights the parent for it). So skip the
// stdin touch entirely when fd 0 is a regular file.
const noopStdin: StdinLike = {
  pause: () => undefined,
  unref: () => undefined,
};

export function stdinNeedsFinalizing(): boolean {
  try {
    return !fstatSync(0).isFile();
  } catch {
    // fd 0 closed or unstattable — nothing to pause/unref either way.
    return false;
  }
}

// Production wiring against the real process streams.
export function finalizeProcess(code: number): void {
  if (keepAlive) return;
  finalize(code, {
    stdout: process.stdout as unknown as WritableLike,
    stderr: process.stderr as unknown as WritableLike,
    stdin: stdinNeedsFinalizing() ? (process.stdin as unknown as StdinLike) : noopStdin,
    exit: (c: number) => process.exit(c),
    setExitCode: (c: number) => {
      process.exitCode = c;
    },
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
}
