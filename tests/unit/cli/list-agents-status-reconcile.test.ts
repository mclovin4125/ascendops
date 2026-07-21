import { describe, it, expect } from 'vitest';
import { reconcileWithLiveStatus } from '../../../src/cli/list-agents.js';
import type { AgentInfo, AgentStatus } from '../../../src/types/index.js';

// Confirmed defect (2026-07-21): `list-agents` infers `running` purely from
// heartbeat staleness (age < 10min), which disagrees with `status`'s live
// PID-tracked view from the daemon. An agent mid-task with no heartbeat in
// the last 10 minutes read as falsely "stopped"; a crashed agent whose last
// heartbeat landed recently read as falsely "running".

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    name: 'dev',
    org: 'testorg',
    role: 'dev',
    enabled: true,
    running: false,
    last_heartbeat: null,
    current_task: null,
    mode: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return { name: 'dev', status: 'running', ...overrides };
}

describe('reconcileWithLiveStatus', () => {
  it('flips a heartbeat-stale agent to running when the daemon reports it live', () => {
    const agents = [makeAgent({ name: 'dev', running: false })];
    const live = [makeStatus({ name: 'dev', status: 'running', pid: 792 })];
    const result = reconcileWithLiveStatus(agents, live);
    expect(result[0].running).toBe(true);
  });

  it('flips a recently-heartbeated agent to stopped when the daemon reports it crashed', () => {
    const agents = [makeAgent({ name: 'dev', running: true })];
    const live = [makeStatus({ name: 'dev', status: 'crashed' })];
    const result = reconcileWithLiveStatus(agents, live);
    expect(result[0].running).toBe(false);
  });

  it('leaves an agent unchanged when the daemon has no live status for it', () => {
    const agents = [makeAgent({ name: 'unmanaged-agent', running: true })];
    const result = reconcileWithLiveStatus(agents, []);
    expect(result[0].running).toBe(true);
  });

  it('does not mutate the input array', () => {
    const agents = [makeAgent({ name: 'dev', running: false })];
    const live = [makeStatus({ name: 'dev', status: 'running' })];
    reconcileWithLiveStatus(agents, live);
    expect(agents[0].running).toBe(false);
  });
});
