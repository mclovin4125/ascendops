import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkTemplateDrift } from '../../../src/cli/doctor.js';

// Two confirmed doctor blind spots (2026-07-21):
// 1. An agent missing .claude/settings.json entirely was silently skipped by the
//    drift check instead of being flagged — worse than drift (every hook gone),
//    yet it produced no finding at all.
// 2. HOOK_KEYS omitted 'SessionStart', so a missing SessionStart hook block
//    (session-restore never runs on resume) went undetected.

const ALL_HOOKS = {
  Stop: [{ hooks: [{ type: 'command', command: 'x' }] }],
  PreCompact: [{ hooks: [{ type: 'command', command: 'x' }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: 'x' }] }],
  PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }],
  PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x' }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }],
};

function writeJson(path: string, data: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

describe('checkTemplateDrift', () => {
  it('flags an agent with no .claude/settings.json at all, instead of silently skipping it', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-drift-'));
    try {
      writeJson(join(root, 'templates', 'agent', '.claude', 'settings.json'), { hooks: ALL_HOOKS });
      writeJson(join(root, 'orgs', 'testorg', 'agents', 'no-settings', 'config.json'), { agent_name: 'no-settings' });
      // deliberately no .claude/settings.json for this agent

      const checks = checkTemplateDrift(root);
      const finding = checks.find(c => c.name === 'Template drift: testorg/no-settings');
      expect(finding).toBeDefined();
      expect(finding?.status).toBe('fail');
      expect(finding?.message).toContain('settings.json is missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a missing SessionStart hook block', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-drift-'));
    try {
      writeJson(join(root, 'templates', 'agent', '.claude', 'settings.json'), { hooks: ALL_HOOKS });
      const { SessionStart, ...hooksMissingSessionStart } = ALL_HOOKS;
      void SessionStart;
      writeJson(join(root, 'orgs', 'testorg', 'agents', 'stale-agent', 'config.json'), { agent_name: 'stale-agent' });
      writeJson(join(root, 'orgs', 'testorg', 'agents', 'stale-agent', '.claude', 'settings.json'), { hooks: hooksMissingSessionStart });

      const checks = checkTemplateDrift(root);
      const finding = checks.find(c => c.name === 'Template drift: testorg/stale-agent');
      expect(finding).toBeDefined();
      expect(finding?.status).toBe('fail');
      expect(finding?.message).toContain('SessionStart');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when every hook block, including SessionStart, is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-drift-'));
    try {
      writeJson(join(root, 'templates', 'agent', '.claude', 'settings.json'), { hooks: ALL_HOOKS });
      writeJson(join(root, 'orgs', 'testorg', 'agents', 'healthy-agent', 'config.json'), { agent_name: 'healthy-agent' });
      writeJson(join(root, 'orgs', 'testorg', 'agents', 'healthy-agent', '.claude', 'settings.json'), { hooks: ALL_HOOKS });

      const checks = checkTemplateDrift(root);
      expect(checks.find(c => c.name.startsWith('Template drift: testorg/healthy-agent'))).toBeUndefined();
      expect(checks.find(c => c.name === 'Agent template drift' && c.status === 'pass')).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips an agent with no config.json (cannot determine its template) without a spurious finding', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-drift-'));
    try {
      writeJson(join(root, 'templates', 'agent', '.claude', 'settings.json'), { hooks: ALL_HOOKS });
      mkdirSync(join(root, 'orgs', 'testorg', 'agents', 'no-config'), { recursive: true });

      const checks = checkTemplateDrift(root);
      expect(checks.find(c => c.name.includes('no-config'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
