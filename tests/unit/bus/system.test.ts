import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { selfRestart, hardRestart, autoCommit, ensureGitRepoInitialized, checkGoalStaleness, postActivity } from '../../../src/bus/system';
import type { BusPaths } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

describe('Bus System', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-system-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('selfRestart', () => {
    it('creates marker file and appends to restarts.log', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent', 'config reload needed');

      // Check marker file
      const markerPath = join(paths.stateDir, '.restart-planned');
      expect(existsSync(markerPath)).toBe(true);
      const markerContent = readFileSync(markerPath, 'utf-8').trim();
      expect(markerContent).toBe('config reload needed');

      // Check restarts.log
      const logPath = join(paths.logDir, 'restarts.log');
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: config reload needed');
      expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent');

      const logPath = join(paths.logDir, 'restarts.log');
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: no reason specified');
    });
  });

  describe('hardRestart', () => {
    it('creates .force-fresh and .restart-planned markers', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context handoff');

      expect(existsSync(join(paths.stateDir, '.force-fresh'))).toBe(true);
      expect(existsSync(join(paths.stateDir, '.restart-planned'))).toBe(true);
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: context handoff');
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent');
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: no reason specified');
    });
  });

  describe('ensureGitRepoInitialized', () => {
    it('initializes a git repo when none exists', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cortextos-ensure-git-test-'));
      try {
        expect(existsSync(join(dir, '.git'))).toBe(false);
        ensureGitRepoInitialized(dir);
        expect(existsSync(join(dir, '.git'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('is idempotent — does not error or reinitialize an existing repo', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cortextos-ensure-git-test-'));
      try {
        ensureGitRepoInitialized(dir);
        execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
        writeFileSync(join(dir, 'file.txt'), 'content');
        execSync('git add file.txt && git commit -m "first"', { cwd: dir, stdio: 'pipe' });

        expect(() => ensureGitRepoInitialized(dir)).not.toThrow();

        // History is untouched by the second call.
        const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' });
        expect(log.trim().split('\n')).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('creates the target directory if it does not exist yet', () => {
      const parent = mkdtempSync(join(tmpdir(), 'cortextos-ensure-git-test-'));
      const nested = join(parent, 'not-yet-created');
      try {
        ensureGitRepoInitialized(nested);
        expect(existsSync(join(nested, '.git'))).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  describe('autoCommit', () => {
    let gitDir: string;

    beforeEach(() => {
      gitDir = mkdtempSync(join(tmpdir(), 'cortextos-autocommit-test-'));
      execSync('git init', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
      // Create initial commit so git status works properly
      writeFileSync(join(gitDir, '.gitkeep'), '');
      execSync('git add .gitkeep && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
    });

    afterEach(() => {
      rmSync(gitDir, { recursive: true, force: true });
    });

    it('filters out .env files', () => {
      writeFileSync(join(gitDir, 'app.env'), 'SECRET=abc');
      writeFileSync(join(gitDir, 'safe.txt'), 'hello');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');
      expect(report.staged).toContain('safe.txt');
      expect(report.blocked.some(b => b.includes('app.env'))).toBe(true);
    });

    it('filters out files with credential patterns', () => {
      writeFileSync(join(gitDir, 'config.json'), '{"token=abc123"}');
      writeFileSync(join(gitDir, 'readme.md'), 'just a readme');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('config.json') && b.includes('credential'))).toBe(true);
      expect(report.staged).toContain('readme.md');
    });

    it('does NOT block ordinary hyphenated words that happen to contain "sk-" (2026-08-11 false positive)', () => {
      // Confirmed regression: "safety-risk-classified" in analyst's
      // goals.json blocked an auto-commit because the old sk- pattern was
      // a bare substring match with no length check — "risk-" contains
      // "sk-". Same shape as "desk-", "task-", "disk-", "mask-".
      writeFileSync(join(gitDir, 'goals.json'), JSON.stringify({
        focus: 'Watch the safety-risk-classified work order for the urgency-framing experiment.',
      }));

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('goals.json');
      expect(report.blocked.some(b => b.includes('goals.json'))).toBe(false);
    });

    it('still blocks a real-shaped sk- secret key (long unbroken alphanumeric run)', () => {
      writeFileSync(join(gitDir, 'notes.md'), 'API key: sk-abcdefghijklmnopqrstuvwxyz0123456789');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('notes.md') && b.includes('credential'))).toBe(true);
    });

    it('allows script files even with credential-like patterns', () => {
      writeFileSync(join(gitDir, 'deploy.sh'), '#!/bin/bash\ntoken=get_from_env');
      writeFileSync(join(gitDir, 'app.py'), 'password=input("Enter:")');
      writeFileSync(join(gitDir, 'main.js'), 'const secret=process.env.SECRET');

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('deploy.sh');
      expect(report.staged).toContain('app.py');
      expect(report.staged).toContain('main.js');
    });

    it('filters out binary/temp files', () => {
      writeFileSync(join(gitDir, 'output.log'), 'log data');
      writeFileSync(join(gitDir, 'cache.tmp'), 'temp');
      writeFileSync(join(gitDir, 'app.pid'), '12345');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('output.log'))).toBe(true);
      expect(report.blocked.some(b => b.includes('cache.tmp'))).toBe(true);
      expect(report.blocked.some(b => b.includes('app.pid'))).toBe(true);
    });

    it('dry-run does not stage files', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');

      // Verify nothing is staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toBe('');
    });

    it('returns clean when no changes', () => {
      const report = autoCommit(gitDir);
      expect(report.status).toBe('clean');
    });

    it('stages safe files when not dry-run', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, false);
      expect(report.status).toBe('staged');
      expect(report.staged).toContain('newfile.txt');

      // Verify file is actually staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8' });
      expect(staged.trim()).toContain('newfile.txt');
    });

    it('returns nothing_to_stage when all files blocked', () => {
      writeFileSync(join(gitDir, 'secrets.env'), 'API_KEY=123');

      const report = autoCommit(gitDir);
      expect(report.status).toBe('nothing_to_stage');
      expect(report.blocked.length).toBeGreaterThan(0);
    });
  });

  describe('checkGoalStaleness', () => {
    it('identifies stale goals', () => {
      // Create org/agent structure with old timestamp
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${oldDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.total).toBe(1);
      expect(report.summary.stale).toBe(1);
      expect(report.agents[0].status).toBe('stale');
      expect(report.agents[0].agent).toBe('worker');
      expect(report.agents[0].org).toBe('myorg');
      expect(report.agents[0].stale).toBe(true);
    });

    it('identifies fresh goals', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.fresh).toBe(1);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('handles missing GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      // No GOALS.md created

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('missing');
      expect(report.agents[0].stale).toBe(true);
      expect(report.agents[0].reason).toContain('no GOALS.md');
    });

    it('handles missing timestamp in GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\nJust some text without updated section');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('no_timestamp');
      expect(report.agents[0].stale).toBe(true);
    });

    it('handles unparseable timestamp', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\n## Updated\nnot-a-date\n');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('parse_error');
      expect(report.agents[0].stale).toBe(true);
    });

    it('strips "(by <author>)" suffix from generated-md timestamps', () => {
      // `cortextos goals generate-md` writes `2026-05-18T11:35:27Z (by dane)`.
      // Without the strip, Date() returns Invalid Date and the cron sees
      // parse_error on every agent.
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      const recentDate = new Date(Date.now() - 86400000).toISOString();
      writeFileSync(
        join(agentDir, 'GOALS.md'),
        `# Goals\n\n## Updated\n${recentDate} (by dane)\n\nSome goal`,
      );

      const report = checkGoalStaleness(testDir, 7);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('returns empty report when no orgs directory', () => {
      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(0);
      expect(report.agents).toEqual([]);
    });

    it('scans multiple orgs and agents', () => {
      // Create two orgs with agents
      for (const org of ['org1', 'org2']) {
        const agentDir = join(testDir, 'orgs', org, 'agents', 'bot');
        mkdirSync(agentDir, { recursive: true });
        const date = new Date().toISOString();
        writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${date}\n`);
      }

      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(2);
    });
  });

  describe('postActivity', () => {
    it('returns false when not configured', async () => {
      const result = await postActivity(
        join(testDir, 'nonexistent'),
        testDir,
        'myorg',
        'hello',
      );
      expect(result).toBe(false);
    });

    it('returns false when env file has no token', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_CHAT_ID=123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });

    it('returns false when env file has no chat ID', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=abc123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });
  });
});
