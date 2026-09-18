import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import type { AgentConfig, AgentStatus, CronExecutionLogEntry, Priority } from '../types/index.js';

/** Escalate to 'urgent' once a day's noop_persistent count exceeds this. */
export const NOOP_PERSISTENT_URGENT_THRESHOLD = 3;

export const CRON_NOOP_VERIFY_DELAY_MS = 75_000;
export interface CronTranscriptLookup {
  found: boolean;
  path?: string;
}

interface CronSaltCandidate {
  salt: string;
  firedAt: string;
}

export function cronFireSalt(firedAt: string, cronName: string): string {
  return `[CRON FIRED ${firedAt}] ${cronName}:`;
}

export function resolveClaudeTranscriptPath(
  config: Pick<AgentConfig, 'working_directory'>,
  agentDir: string,
  homeDir: string = homedir(),
): string | null {
  const launchDir = config.working_directory || agentDir;
  if (!launchDir) return null;

  const convDir = join(
    homeDir,
    '.claude',
    'projects',
    launchDir.split(sep).join('-'),
  );

  try {
    const jsonlFiles = readdirSync(convDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((file) => {
        const path = join(convDir, file);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return jsonlFiles[0]?.path ?? null;
  } catch {
    return null;
  }
}

function contentContainsSalt(content: unknown, salt: string): boolean {
  if (typeof content === 'string') return content.includes(salt);
  try {
    return JSON.stringify(content).includes(salt);
  } catch {
    return false;
  }
}

/**
 * A salted user turn only proves the daemon *delivered* the cron prompt into the
 * transcript - the daemon injects it unconditionally, whether or not the CLI can
 * actually process it. It does not prove the agent *executed* anything.
 *
 * 2026-09-18 fleet-wide incident: a Claude Code CLI login expiry made every turn
 * on all 4 agent seats return a synthetic `isApiErrorMessage` placeholder ("Not
 * logged in / Login expired - Please run /login") for ~24 days. The salt still
 * landed in every `type: "user"` row right on schedule, so this detector marked
 * 240+ dead fires "confirmed" and never escalated - the one safety net built for
 * exactly this failure mode was blind to it. See memory/2026-09-18.md.
 *
 * Fix: a real cron execution always issues at least one tool call (bus commands
 * for heartbeat/inbox/etc per HEARTBEAT.md). Require a genuine `tool_use` block
 * in an assistant turn following the salted user turn before calling it found.
 */
function hasRealToolUse(row: any): boolean {
  if (row?.type !== 'assistant') return false;
  const content = row?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block && typeof block === 'object' && block.type === 'tool_use');
}

/** How many rows past a salted user turn to search for a confirming tool_use. */
const TOOL_USE_LOOKAHEAD_ROWS = 50;

export function transcriptContainsCronTurn(
  transcriptPath: string | null,
  salt: string,
  firedAt: string,
): CronTranscriptLookup {
  return transcriptContainsAnyCronTurn(transcriptPath, [{ salt, firedAt }]);
}

function transcriptContainsAnyCronTurn(
  transcriptPath: string | null,
  candidates: CronSaltCandidate[],
): CronTranscriptLookup {
  if (!transcriptPath || !existsSync(transcriptPath)) return { found: false };

  const parsedCandidates = candidates
    .map((candidate) => ({
      ...candidate,
      firedMs: Date.parse(candidate.firedAt),
    }))
    .filter((candidate) => Number.isFinite(candidate.firedMs));
  if (parsedCandidates.length === 0) return { found: false, path: transcriptPath };

  try {
    const rows: any[] = [];
    const transcript = readFileSync(transcriptPath, 'utf-8');
    for (const line of transcript.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines but keep their index out of `rows`
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row?.type !== 'user') continue;
      const tsMs = Date.parse(String(row.timestamp || ''));
      if (!Number.isFinite(tsMs)) continue;
      const matched = parsedCandidates.some((candidate) =>
        tsMs >= candidate.firedMs && contentContainsSalt(row?.message?.content, candidate.salt),
      );
      if (!matched) continue;

      // Salt delivered - now look for proof the agent actually acted on it.
      // Stop at the next user turn so a much later, unrelated tool call in the
      // same long-running session can't be misattributed to this fire.
      const windowEnd = Math.min(rows.length, i + 1 + TOOL_USE_LOOKAHEAD_ROWS);
      for (let j = i + 1; j < windowEnd; j++) {
        const candidateRow = rows[j];
        if (candidateRow?.type === 'user') break;
        if (hasRealToolUse(candidateRow)) {
          return { found: true, path: transcriptPath };
        }
      }
    }
  } catch {
    return { found: false, path: transcriptPath };
  }

  return { found: false, path: transcriptPath };
}

type InjectResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' | 'DEDUPED'; message: string };

interface PendingCronVerification {
  agentName: string;
  agentDir: string;
  config: AgentConfig;
  cronName: string;
  prompt: string;
  firedAt: string;
  salt: string;
  acceptedSalts: CronSaltCandidate[];
  window: 1 | 2;
  reinjects: number;
  timer?: NodeJS.Timeout;
}

export interface CronNoopDetectorOptions {
  verifyDelayMs?: number;
  appendExecutionLog: (agentName: string, entry: CronExecutionLogEntry) => void;
  emitEvent: (agentName: string, event: string, severity: 'info' | 'warning' | 'error', meta: Record<string, unknown>) => void;
  getStatus: (agentName: string) => AgentStatus | null;
  inject: (agentName: string, text: string) => InjectResult;
  notifyOrchestrator: (agentName: string, text: string, priority?: Priority) => void;
  hasActivitySince?: (agentName: string, firedAt: string) => boolean;
  /** Count of this agent's noop_persistent entries logged so far today (inclusive of the one just appended). */
  countTodayNoopPersistent?: (agentName: string) => number;
  logger?: (msg: string) => void;
  now?: () => Date;
  transcriptPathFor?: (agentDir: string, config: AgentConfig) => string | null;
}

export class CronNoopDetector {
  private readonly verifyDelayMs: number;
  private readonly pending = new Map<string, PendingCronVerification>();
  private readonly appendExecutionLog: CronNoopDetectorOptions['appendExecutionLog'];
  private readonly emitEvent: CronNoopDetectorOptions['emitEvent'];
  private readonly getStatus: CronNoopDetectorOptions['getStatus'];
  private readonly inject: CronNoopDetectorOptions['inject'];
  private readonly notifyOrchestrator: CronNoopDetectorOptions['notifyOrchestrator'];
  private readonly hasActivitySince: (agentName: string, firedAt: string) => boolean;
  private readonly countTodayNoopPersistent: (agentName: string) => number;
  private readonly logger: (msg: string) => void;
  private readonly now: () => Date;
  private readonly transcriptPathFor: (agentDir: string, config: AgentConfig) => string | null;

  constructor(options: CronNoopDetectorOptions) {
    this.verifyDelayMs = options.verifyDelayMs ?? CRON_NOOP_VERIFY_DELAY_MS;
    this.appendExecutionLog = options.appendExecutionLog;
    this.emitEvent = options.emitEvent;
    this.getStatus = options.getStatus;
    this.inject = options.inject;
    this.notifyOrchestrator = options.notifyOrchestrator;
    this.hasActivitySince = options.hasActivitySince ?? (() => false);
    this.countTodayNoopPersistent = options.countTodayNoopPersistent ?? (() => 0);
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.transcriptPathFor = options.transcriptPathFor ?? ((agentDir, config) => resolveClaudeTranscriptPath(config, agentDir));
  }

  registerFire(input: {
    agentName: string;
    agentDir: string;
    config: AgentConfig;
    cronName: string;
    prompt: string;
    firedAt: string;
  }): void {
    if (input.config.runtime === 'codex-app-server' || input.config.runtime === 'hermes') {
      return;
    }
    const salt = cronFireSalt(input.firedAt, input.cronName);
    this.schedule({
      agentName: input.agentName,
      agentDir: input.agentDir,
      config: input.config,
      cronName: input.cronName,
      prompt: input.prompt,
      firedAt: input.firedAt,
      salt,
      acceptedSalts: [{ salt, firedAt: input.firedAt }],
      window: 1,
      reinjects: 0,
    });
  }

  private keyFor(pending: Pick<PendingCronVerification, 'agentName' | 'cronName' | 'firedAt' | 'reinjects'>): string {
    return `${pending.agentName}:${pending.cronName}:${pending.firedAt}:${pending.reinjects}`;
  }

  private schedule(pending: PendingCronVerification): void {
    const key = this.keyFor(pending);
    pending.timer = setTimeout(() => this.verify(key), this.verifyDelayMs);
    this.pending.set(key, pending);
  }

  cancelAgentVerifications(agentName: string): number {
    let cancelled = 0;
    for (const [key, pending] of this.pending.entries()) {
      if (pending.agentName !== agentName) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);
      cancelled += 1;
    }
    if (cancelled > 0) {
      this.logger(`[cron-noop-detector] cancelled ${cancelled} pending verification(s) for ${agentName}`);
    }
    return cancelled;
  }

  private verify(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;

    try {
      const transcriptPath = this.transcriptPathFor(pending.agentDir, pending.config);
      const lookup = transcriptContainsAnyCronTurn(transcriptPath, pending.acceptedSalts);
      if (lookup.found) {
        this.appendExecutionLog(pending.agentName, {
          ts: this.now().toISOString(),
          cron: pending.cronName,
          status: 'confirmed',
          attempt: pending.window,
          duration_ms: 0,
          error: null,
        });
        this.pending.delete(key);
        return;
      }

      if (this.activityConfirmsCronFire(pending)) {
        this.appendExecutionLog(pending.agentName, {
          ts: this.now().toISOString(),
          cron: pending.cronName,
          status: 'confirmed',
          attempt: pending.window,
          duration_ms: 0,
          error: null,
        });
        this.emitEvent(pending.agentName, 'cron_fire_confirmed_by_activity', 'info', {
          agent: pending.agentName,
          cron: pending.cronName,
          fired_at: pending.firedAt,
          salt: pending.salt,
          transcript_path: lookup.path ?? transcriptPath ?? null,
          reinjects: pending.reinjects,
        });
        this.pending.delete(key);
        return;
      }

      if (pending.window === 1) {
        this.appendExecutionLog(pending.agentName, {
          ts: this.now().toISOString(),
          cron: pending.cronName,
          status: 'noop_unconfirmed',
          attempt: 1,
          duration_ms: 0,
          error: null,
        });
        this.emitEvent(pending.agentName, 'cron_fire_unconfirmed', 'info', {
          agent: pending.agentName,
          cron: pending.cronName,
          fired_at: pending.firedAt,
          salt: pending.salt,
          transcript_path: lookup.path ?? transcriptPath ?? null,
          reinjects: pending.reinjects,
        });
        this.pending.delete(key);
        this.schedule({ ...pending, window: 2, timer: undefined });
        return;
      }

      this.pending.delete(key);
      if (pending.reinjects === 0) {
        this.reinject(pending);
      } else {
        this.escalatePersistent(pending, lookup.path ?? transcriptPath ?? null);
      }
    } catch (err) {
      this.pending.delete(key);
      this.logger(`[cron-noop-detector] verification failed for ${pending.agentName}/${pending.cronName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private activityConfirmsCronFire(pending: PendingCronVerification): boolean {
    try {
      return this.hasActivitySince(pending.agentName, pending.firedAt);
    } catch (err) {
      this.logger(`[cron-noop-detector] activity evidence check failed for ${pending.agentName}/${pending.cronName}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private reinject(pending: PendingCronVerification): void {
    const status = this.getStatus(pending.agentName)?.status;
    if (status !== 'running') {
      this.escalatePersistent(pending, null, `agent status ${status ?? 'unknown'}; re-inject skipped`);
      return;
    }

    const firedAt = this.now().toISOString();
    const salt = cronFireSalt(firedAt, pending.cronName);
    const injection = `[CRON FIRED ${firedAt}] ${pending.cronName}: ${pending.prompt}`;
    const result = this.inject(pending.agentName, injection);
    if (!result.ok) {
      this.escalatePersistent(pending, null, result.message);
      return;
    }

    const next: PendingCronVerification = {
      ...pending,
      firedAt,
      salt,
      acceptedSalts: [
        ...pending.acceptedSalts,
        { salt, firedAt },
      ],
      window: 1,
      reinjects: 1,
      timer: undefined,
    };
    this.appendExecutionLog(pending.agentName, {
      ts: this.now().toISOString(),
      cron: pending.cronName,
      status: 'noop_reinjected',
      attempt: 2,
      duration_ms: 0,
      error: null,
    });
    this.emitEvent(pending.agentName, 'cron_fire_reinjected', 'warning', {
      agent: pending.agentName,
      cron: pending.cronName,
      original_fired_at: pending.firedAt,
      reinjected_fired_at: firedAt,
      original_salt: pending.salt,
      reinjected_salt: next.salt,
    });
    this.schedule(next);
  }

  private escalatePersistent(pending: PendingCronVerification, transcriptPath: string | null, reason?: string): void {
    this.appendExecutionLog(pending.agentName, {
      ts: this.now().toISOString(),
      cron: pending.cronName,
      status: 'noop_persistent',
      attempt: pending.window,
      duration_ms: 0,
      error: reason ?? 'salted user turn absent after re-inject verification windows',
    });
    const meta = {
      agent: pending.agentName,
      cron: pending.cronName,
      fired_at: pending.firedAt,
      salt: pending.salt,
      transcript_path: transcriptPath,
      reason: reason ?? 'salted user turn absent after re-inject verification windows',
    };
    this.emitEvent(pending.agentName, 'cron_fire_noop_persistent', 'error', meta);

    const occurrencesToday = this.countTodayNoopPersistent(pending.agentName);
    const priority: Priority = occurrencesToday > NOOP_PERSISTENT_URGENT_THRESHOLD ? 'urgent' : 'normal';
    this.notifyOrchestrator(
      pending.agentName,
      `Persistent cron fire no-op detected for ${pending.agentName}/${pending.cronName} (${occurrencesToday} today). Salt was not found in the Claude transcript after detector verification and one safe re-inject. Reason: ${meta.reason}`,
      priority,
    );
  }
}
