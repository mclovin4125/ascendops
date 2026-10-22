import { describe, it, expect, vi, afterEach } from 'vitest';

const fstatSyncMock = vi.fn();
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    fstatSync: (...args: unknown[]) => fstatSyncMock(...args),
  };
});

import {
  finalize,
  finalizeProcess,
  requestKeepAlive,
  shouldKeepAlive,
  resetKeepAlive,
  stdinNeedsFinalizing,
  DRAIN_TIMEOUT_MS,
  type FinalizeDeps,
} from '../../../src/cli/_finalize';

// Build a deps harness with controllable stdout/stderr buffer state.
function makeDeps(overrides: Partial<{ stdoutBuffered: number; stderrBuffered: number }> = {}) {
  const exit = vi.fn();
  const setExitCode = vi.fn();
  const pause = vi.fn();
  const unref = vi.fn();
  const timerUnref = vi.fn();
  const setTimer = vi.fn(() => ({ unref: timerUnref }));

  // write() captures the flush callback so the test controls when it fires.
  const stdoutCb: Array<() => void> = [];
  const stderrCb: Array<() => void> = [];

  const deps: FinalizeDeps = {
    stdout: {
      writableLength: overrides.stdoutBuffered ?? 0,
      write: (_chunk: string, cb: () => void) => {
        stdoutCb.push(cb);
        return true;
      },
    },
    stderr: {
      writableLength: overrides.stderrBuffered ?? 0,
      write: (_chunk: string, cb: () => void) => {
        stderrCb.push(cb);
        return true;
      },
    },
    stdin: { pause, unref },
    exit,
    setExitCode,
    setTimer,
  };

  return { deps, exit, setExitCode, pause, unref, setTimer, timerUnref, stdoutCb, stderrCb };
}

describe('finalize (drain-safe exit)', () => {
  it('sets the exit code and releases stdin', () => {
    const h = makeDeps();
    finalize(0, h.deps);
    expect(h.setExitCode).toHaveBeenCalledWith(0);
    expect(h.pause).toHaveBeenCalled();
    expect(h.unref).toHaveBeenCalled();
  });

  it('exits immediately when nothing is buffered (no truncation risk)', () => {
    const h = makeDeps({ stdoutBuffered: 0, stderrBuffered: 0 });
    finalize(0, h.deps);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.exit).toHaveBeenCalledTimes(1);
    // No drain needed, so no safety-net timer.
    expect(h.setTimer).not.toHaveBeenCalled();
  });

  it('waits for stdout to drain before exiting when bytes are buffered', () => {
    const h = makeDeps({ stdoutBuffered: 4096 });
    finalize(0, h.deps);
    // Must NOT exit until the flush callback fires (this is the truncation guard).
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), DRAIN_TIMEOUT_MS);
    // Simulate the flush completing.
    h.stdoutCb[0]();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('waits for BOTH stdout and stderr to drain before exiting', () => {
    const h = makeDeps({ stdoutBuffered: 100, stderrBuffered: 100 });
    finalize(1, h.deps);
    expect(h.exit).not.toHaveBeenCalled();
    h.stdoutCb[0]();
    expect(h.exit).not.toHaveBeenCalled(); // stderr still pending
    h.stderrCb[0]();
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('arms an unref-d safety-net timer so a stuck consumer cannot hang forever', () => {
    const h = makeDeps({ stdoutBuffered: 100 });
    finalize(0, h.deps);
    expect(h.setTimer).toHaveBeenCalledWith(expect.any(Function), DRAIN_TIMEOUT_MS);
    expect(h.timerUnref).toHaveBeenCalled();
    // The timer callback force-exits even if drain never completes.
    const timerCb = h.setTimer.mock.calls[0][0];
    timerCb();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('does not throw if stdin is already closed', () => {
    const h = makeDeps();
    h.deps.stdin.pause = () => {
      throw new Error('stdin destroyed');
    };
    expect(() => finalize(0, h.deps)).not.toThrow();
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('stdinNeedsFinalizing (regular-file stdin vs. socket/pipe/tty)', () => {
  afterEach(() => {
    fstatSyncMock.mockReset();
  });

  it('is false when fd 0 is a regular file — the `while read ... < file` shell-loop case this fix targets', () => {
    fstatSyncMock.mockReturnValue({ isFile: () => true });
    expect(stdinNeedsFinalizing()).toBe(false);
  });

  it('is true when fd 0 is not a regular file (tty/socket/pipe) — preserves the Node 25 hang fix', () => {
    fstatSyncMock.mockReturnValue({ isFile: () => false });
    expect(stdinNeedsFinalizing()).toBe(true);
  });

  it('is false (safe no-touch default) when fstat on fd 0 throws', () => {
    fstatSyncMock.mockImplementation(() => {
      throw new Error('EBADF');
    });
    expect(stdinNeedsFinalizing()).toBe(false);
  });
});

describe('keepAlive opt-out (finalizeProcess guard)', () => {
  afterEach(() => {
    resetKeepAlive();
    vi.restoreAllMocks();
  });

  it('defaults to not keeping the process alive', () => {
    expect(shouldKeepAlive()).toBe(false);
  });

  it('requestKeepAlive flips the flag (and resetKeepAlive clears it)', () => {
    requestKeepAlive();
    expect(shouldKeepAlive()).toBe(true);
    resetKeepAlive();
    expect(shouldKeepAlive()).toBe(false);
  });

  it('finalizeProcess is a NO-OP when keepAlive is set (long-lived commands like start --foreground)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    requestKeepAlive();
    finalizeProcess(0);
    // The guard must prevent the forced exit so the foreground daemon is not killed.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('finalizeProcess attempts to exit when keepAlive is NOT set (one-shot commands)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    resetKeepAlive();
    finalizeProcess(0);
    // With no keepAlive, the one-shot path drains and exits. In the test runner
    // stdout has no buffered bytes, so exit fires synchronously.
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
