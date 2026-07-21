import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// resolvePaths() (src/utils/paths.ts) resolves ctxRoot via os.homedir(), not
// CTX_ROOT, so homedir must be mocked to isolate this test from the real
// ~/.cortextos directory. vi.hoisted lets the mock factory (which vitest
// hoists above these imports) see a value we can still reassign per test.
const mockHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => mockHome.dir };
});

import { busCommand } from '../../../src/cli/bus';

let homeDir: string;
let frameworkRoot: string;
const AGENT = 'testagent';
const ORG = 'testorg';
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalAgentName = process.env.CTX_AGENT_NAME;
const originalOrg = process.env.CTX_ORG;
const originalInstanceId = process.env.CTX_INSTANCE_ID;

function heartbeatPath(): string {
  return join(homeDir, '.cortextos', 'default', 'state', AGENT, 'heartbeat.json');
}

function readHeartbeat(): Record<string, unknown> {
  return JSON.parse(readFileSync(heartbeatPath(), 'utf-8'));
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'update-heartbeat-home-'));
  mockHome.dir = homeDir;
  frameworkRoot = mkdtempSync(join(tmpdir(), 'update-heartbeat-fw-'));
  mkdirSync(join(frameworkRoot, 'orgs', ORG, 'agents', AGENT), { recursive: true });

  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_AGENT_NAME = AGENT;
  process.env.CTX_ORG = ORG;
  process.env.CTX_INSTANCE_ID = 'default';
});

afterEach(() => {
  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot; else delete process.env.CTX_FRAMEWORK_ROOT;
  if (originalAgentName !== undefined) process.env.CTX_AGENT_NAME = originalAgentName; else delete process.env.CTX_AGENT_NAME;
  if (originalOrg !== undefined) process.env.CTX_ORG = originalOrg; else delete process.env.CTX_ORG;
  if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId; else delete process.env.CTX_INSTANCE_ID;
  try { rmSync(homeDir, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }
});

describe('bus update-heartbeat --display-name', () => {
  it('an explicit --display-name overrides whatever IDENTITY.md would parse to', async () => {
    writeFileSync(
      join(frameworkRoot, 'orgs', ORG, 'agents', AGENT, 'IDENTITY.md'),
      '# Agent Identity\n\n## Name\nFromIdentityFile\n',
    );

    await busCommand.parseAsync([
      'node', 'bus', 'update-heartbeat', 'status text', '--display-name', 'ExplicitOverride',
    ]);

    expect(readHeartbeat().display_name).toBe('ExplicitOverride');
  });

  it('falls back to parsing IDENTITY.md when --display-name is not passed', async () => {
    writeFileSync(
      join(frameworkRoot, 'orgs', ORG, 'agents', AGENT, 'IDENTITY.md'),
      '# Agent Identity\n\n## Name\nMason\n',
    );

    await busCommand.parseAsync(['node', 'bus', 'update-heartbeat', 'status text']);

    expect(readHeartbeat().display_name).toBe('Mason');
  });
});
