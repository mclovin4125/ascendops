import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Approval, ApprovalCategory, ApprovalStatus, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { parseEnvFile } from '../utils/env.js';
import { randomString } from '../utils/random.js';
import { validateApprovalCategory } from '../utils/validate.js';
import { redactSSN } from '../utils/ssn-redaction.js';
import { TelegramAPI } from '../telegram/api.js';
import { sendMessage } from './message.js';
import { postActivity } from './system.js';

/**
 * Build the inline keyboard posted to the activity channel alongside a
 * newly-created approval. Two buttons (Approve / Deny) with callback_data
 * keyed on the approval id so fast-checker's activity-channel callback
 * handler can route them to updateApproval.
 */
function buildApprovalKeyboard(approvalId: string): object {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `appr_allow_${approvalId}` },
      { text: '❌ Deny', callback_data: `appr_deny_${approvalId}` },
    ]],
  };
}

/**
 * Post a newly-created approval to the org's activity channel with
 * Approve/Deny inline buttons. Returns a promise that resolves once the
 * post attempt has settled.
 *
 * Path resolution: activity-channel.env lives under the FRAMEWORK root
 * (frameworkRoot/orgs/<org>/activity-channel.env), NOT the runtime state
 * dir (ctxRoot/orgs/<org>/). The earlier version of this helper used
 * paths.ctxRoot to derive orgDir, which silently resolved to the wrong
 * filesystem root and caused every activity-channel post to fail as
 * "not configured" — a bug that hid for hours because of the silent
 * .catch below. Fallback chain is now: explicit frameworkRoot arg →
 * process.env.CTX_FRAMEWORK_ROOT → SKIP WITH WARN (no further fallback;
 * the paths.ctxRoot fallback that caused the original bug was removed
 * deliberately per post-incident review — silently using a known-wrong
 * path is worse than skipping loudly).
 *
 * Errors from postActivity (thrown rejections) are suppressed so
 * activity-channel unreachability does not block approval creation. The
 * "not configured" signal (postActivity returns false) is now logged as
 * a visible warn — preserves the best-effort behavior but surfaces
 * misconfiguration immediately instead of debugging it silently.
 *
 * The returned promise MUST be awaited by the caller in short-lived
 * contexts (CLI action handlers) or the process may exit before the
 * underlying fetch completes and the post silently never sends.
 */
function postApprovalToActivityChannel(
  paths: BusPaths,
  org: string,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
  frameworkRoot: string | undefined,
): Promise<void> {
  const root = frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT;
  if (!root) {
    console.warn(
      `[approval] No frameworkRoot available for ${approvalId} — skipping activity-channel post. ` +
      `Set CTX_FRAMEWORK_ROOT env var or pass frameworkRoot explicitly.`,
    );
    return Promise.resolve();
  }

  const orgDir = join(root, 'orgs', org);
  const lines = [
    `🔔 Approval request: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  const message = lines.join('\n');

  return postActivity(orgDir, paths.ctxRoot, org, message, buildApprovalKeyboard(approvalId))
    .then((posted) => {
      if (!posted) {
        // postActivity returns false when activity-channel.env is missing
        // or cannot be parsed. Surface this visibly — the silent-false
        // pattern is what hid tonight's path-resolution bug for hours.
        console.warn(
          `[approval] Activity-channel post failed for ${approvalId} — ` +
          `check ${orgDir}/activity-channel.env (must define ACTIVITY_BOT_TOKEN + ACTIVITY_CHAT_ID).`,
        );
      }
    })
    .catch(() => undefined); // Thrown rejections still suppressed — activity-channel unreachable must not fail approval creation.
}

/**
 * Best-effort: ping the requesting agent's own Telegram chat (the operator's
 * 1:1 conversation with the agent's bot) when a new approval is created.
 * The activity-channel post handles "Approve / Deny" inline routing for the
 * operator-via-orchestrator UX, but operators on a per-agent bot would
 * otherwise miss approvals entirely — that's the source of the observed
 * 50h+ Repo-B-style stalls. This pings them on the bot they're actually
 * watching so they can hop to the orchestrator chat or dashboard to act.
 *
 * Reads BOT_TOKEN + CHAT_ID from `<agentDir>/.env`. Skips silently with a
 * single warn line when either is missing — approvals from a bot-less
 * agent (e.g. a hermes runtime, or pre-onboarding) must still succeed.
 *
 * Errors from the network round-trip are suppressed: a Telegram outage
 * must not block approval creation.
 */
function pingAgentChatId(
  agentDir: string | undefined,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
): Promise<void> {
  if (!agentDir) {
    console.warn(
      `[approval] No agentDir available for ${approvalId} — skipping agent-bot Telegram ping.`,
    );
    return Promise.resolve();
  }
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) {
    return Promise.resolve();
  }
  const env = parseEnvFile(envPath);
  const botToken = env.BOT_TOKEN;
  const chatId = env.CHAT_ID;
  if (!botToken || !chatId) {
    console.warn(
      `[approval] BOT_TOKEN or CHAT_ID missing in ${envPath} — skipping agent-bot Telegram ping for ${approvalId}.`,
    );
    return Promise.resolve();
  }

  const lines = [
    `🔔 Approval needed: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  lines.push('', 'Approve via the orchestrator chat (Approve/Deny buttons) or the dashboard.');
  const message = lines.join('\n');

  const api = new TelegramAPI(botToken);
  return api.sendMessage(chatId, message, undefined, { parseMode: null })
    .then(() => undefined)
    .catch(() => undefined); // Telegram outage must not fail approval creation.
}

/**
 * Create an approval request.
 * Identical to bash create-approval.sh format.
 *
 * Returns a Promise that resolves to the approval id AFTER the
 * activity-channel fan-out has settled. Callers in short-lived contexts
 * (CLI action handlers) MUST await — otherwise the process may exit before
 * the Telegram post completes and the post silently never sends.
 *
 * `frameworkRoot` (optional) is the filesystem root where
 * orgs/<org>/activity-channel.env lives. Without it the activity-channel
 * post is skipped with a warn — see postApprovalToActivityChannel for the
 * fallback chain (explicit arg → CTX_FRAMEWORK_ROOT env → skip). CLI call
 * sites should pass env.frameworkRoot explicitly; daemon-side callers
 * may rely on the env var.
 */
export async function createApproval(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  category: ApprovalCategory,
  context?: string,
  frameworkRoot?: string,
  agentDir?: string,
): Promise<string> {
  validateApprovalCategory(category);

  // Scrub before persisting: the approval JSON is written to disk (a
  // never-STORE surface) and a title/context can carry connector data (e.g. a
  // draft with a tenant SSN). The Telegram fan-out is scrubbed at the
  // TelegramAPI primitive; the at-rest JSON must be scrubbed here.
  title = redactSSN(title);
  if (context !== undefined) context = redactSSN(context);

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const approvalId = `approval_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const approval: Approval = {
    id: approvalId,
    title,
    requesting_agent: agentName,
    org,
    category,
    status: 'pending',
    description: context || '',
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
  };

  const pendingDir = join(paths.approvalDir, 'pending');
  ensureDir(pendingDir);
  atomicWriteSync(join(pendingDir, `${approvalId}.json`), JSON.stringify(approval));

  // Fan-out to the activity channel so the operator can approve/deny from
  // Telegram without opening the dashboard. AWAITED so short-lived CLI callers do
  // not exit before the Telegram post fetch completes. Errors are
  // suppressed inside postApprovalToActivityChannel — activity-channel
  // unreachable must not block approval creation. Callbacks route back
  // via the orchestrator's activity-channel poller (see
  // daemon/agent-manager.ts).
  await postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context, frameworkRoot);

  // Best-effort ping to the requesting agent's own Telegram bot (the
  // operator's 1:1 conversation with the agent). Closes the gap where
  // operators not in the activity channel would miss approvals entirely
  // (the 50h+ Repo-B-style stall). Errors suppressed — see helper.
  await pingAgentChatId(agentDir, approvalId, title, category, agentName, context);

  return approvalId;
}

/**
 * Update an approval's status (approve or deny).
 * Notifies the requesting agent via inbox message.
 *
 * `resolvedByAgent` (optional) identifies who is calling this — pass it from
 * a CLI/library caller that has a real agent identity to enforce (see below).
 * Leave it undefined for callers that already carry their own, independent
 * authorization (the daemon's Telegram activity-channel callback checks the
 * inbound Telegram user against an allow-list before ever calling this; the
 * dashboard's API route always resolves as agent name "dashboard", which
 * cannot equal a real requesting_agent) — those paths are not a bare agent
 * self-service call and should not be gated by this check.
 *
 * Confirmed 2026-08-10: an agent could satisfy an --approved-by gate (e.g.
 * sendSms, sendRentVineChatMessage) by calling `create-approval` and
 * `update-approval` on its own request back-to-back, from its own session,
 * with nothing stopping it — defeating the entire point of a Tier 3 human
 * check. This closes that hole for the plain CLI path: an agent's own
 * session cannot resolve its own approval, because the CLI always passes
 * its own agent identity here.
 */
export function updateApproval(
  paths: BusPaths,
  approvalId: string,
  status: ApprovalStatus,
  note?: string,
  resolvedByAgent?: string,
): void {
  // Scrub the resolution note before it is persisted into resolved_by (at-rest
  // JSON) and before it goes into the decision notification below. Sibling of
  // the createApproval title/context scrub.
  if (note !== undefined) note = redactSSN(note);
  const pendingDir = join(paths.approvalDir, 'pending');
  const filePath = join(pendingDir, `${approvalId}.json`);

  // Read + parse in its own try/catch so a genuinely missing/corrupt file
  // reports "not found" — the self-resolution check below must NOT get
  // caught and rewrapped into that same misleading message.
  let approval: Approval;
  try {
    const content = readFileSync(filePath, 'utf-8');
    approval = JSON.parse(content);
  } catch (err) {
    throw new Error(`Approval ${approvalId} not found: ${err}`);
  }

  if (resolvedByAgent && resolvedByAgent === approval.requesting_agent) {
    throw new Error(
      `approval ${approvalId} cannot be resolved by ${resolvedByAgent} — it is the same agent ` +
      'that requested it. Approvals must be resolved by Mack (via Telegram or the dashboard), ' +
      'not self-granted by the requesting agent.',
    );
  }

  approval.status = status;
  approval.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  approval.resolved_at = approval.updated_at;
  approval.resolved_by = note || null;

  // Move to resolved/ directory (matches bash version)
  const destDir = join(paths.approvalDir, 'resolved');
  ensureDir(destDir);
  atomicWriteSync(join(destDir, `${approvalId}.json`), JSON.stringify(approval));

  // Remove from pending
  const { unlinkSync } = require('fs');
  unlinkSync(filePath);

  // Notify requesting agent via inbox
  if (approval.requesting_agent) {
    const noteText = note ? ` Note: ${note}` : '';
    const msg = `Approval decision: ${status.toUpperCase()}\napproval_id: ${approvalId}\ndecision: ${status}${noteText}`;
    sendMessage(paths, 'system', approval.requesting_agent, 'urgent', msg);
  }
}

/**
 * Flag an already-resolved approval as corrected — added after the
 * 2026-08-12 WO #100059 incident, where an approval was resolved in error
 * (a peer agent misread which of several open items Mack meant) and the
 * correction ended up documented only in memory notes and GUARDRAILS.md,
 * fragmenting the audit trail away from the approval record itself.
 *
 * This is deliberately append-only, NOT a rewrite: the original
 * status/resolved_by/resolved_at are left untouched, so the record still
 * shows exactly what was decided AND that it was later found wrong —
 * both facts, not one overwriting the other.
 *
 * Deliberately NOT gated the way updateApproval's resolvedByAgent check is.
 * Self-approval risk is about an agent granting itself new permission;
 * flagging your own mistake is the opposite — it should be as easy as
 * possible so it actually happens (this is exactly how WO #100059 got
 * caught: the same agent that misresolved it corrected itself within
 * minutes). The safety property here is append-only + always-visible, not
 * who is allowed to say it.
 *
 * Only applies to an approval that has already been resolved (moved to
 * resolved/) — a still-pending approval doesn't need "correction," it can
 * just be resolved normally.
 */
export function correctApproval(
  paths: BusPaths,
  approvalId: string,
  correctionNote: string,
  correctedBy: string,
): void {
  if (!correctionNote || !correctionNote.trim()) {
    throw new Error('correction requires a non-empty note explaining what was wrong');
  }
  const scrubbedNote = redactSSN(correctionNote);

  const resolvedFile = join(paths.approvalDir, 'resolved', `${approvalId}.json`);
  let approval: Approval;
  try {
    approval = JSON.parse(readFileSync(resolvedFile, 'utf-8'));
  } catch (err) {
    // Distinguish "still pending" from "never existed" — both land here
    // (readFileSync throws either way), but the fix differs: a pending
    // approval should be resolved normally, not corrected.
    const pendingFile = join(paths.approvalDir, 'pending', `${approvalId}.json`);
    if (existsSync(pendingFile)) {
      throw new Error(`approval ${approvalId} is still pending, not yet resolved — resolve it first, there is nothing to correct yet`);
    }
    throw new Error(`resolved approval ${approvalId} not found: ${err}`);
  }

  approval.corrected = true;
  approval.correction_note = scrubbedNote;
  approval.corrected_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  approval.corrected_by = correctedBy;

  atomicWriteSync(resolvedFile, JSON.stringify(approval));

  if (approval.requesting_agent) {
    const msg = `Approval correction: ${approvalId} has been flagged as corrected by ${correctedBy}.\n` +
      `Original decision: ${approval.status}\nCorrection note: ${scrubbedNote}`;
    sendMessage(paths, 'system', approval.requesting_agent, 'urgent', msg);
  }
}

/**
 * Default: flag a pending approval unresolved for 3h+.
 *
 * Deliberately set BELOW the default 4h heartbeat cadence, not equal to it.
 * heartbeat/SKILL.md's approval sweep runs this check on every fire; if the
 * threshold equalled the interval, an approval created shortly after a fire
 * would still be under 4h old at the very next fire (which lands just under
 * 4h later) and would silently miss that cycle, not getting flagged until
 * the fire AFTER that — up to ~8h stale before anyone is told, double the
 * intended SLA. At 3h, the gap between an approval's creation and the next
 * heartbeat fire (always < 4h) is guaranteed to exceed the threshold, so it
 * is caught on the very first eligible cycle even with cron-fire jitter.
 * Confirmed as the mechanism behind "2h/4h reminder steps silently slip
 * between 4h-spaced heartbeat fires" (2026-08-09 goal).
 */
export const DEFAULT_APPROVAL_STALE_MS = 3 * 60 * 60 * 1000;

/**
 * True when a pending approval's created_at is at least thresholdMs old.
 * Approvals block on a human decision indefinitely by design (no auto-expiry),
 * so this is purely a visibility signal — surfaced via list-approvals --stale
 * so an aging approval doesn't require someone to manually diff created_at
 * against "now" (see MEMORY.md 2026-07-26: work stuck behind an unresolved
 * approval is otherwise invisible until someone checks by hand). Mirrors
 * isStatusStringStale's shape (heartbeat.ts) for consistency.
 */
export function isApprovalStale(
  approval: Pick<Approval, 'created_at'>,
  thresholdMs: number = DEFAULT_APPROVAL_STALE_MS,
  nowMs: number = Date.now(),
): boolean {
  const created = new Date(approval.created_at).getTime();
  if (Number.isNaN(created)) return false;
  return nowMs - created >= thresholdMs;
}

/**
 * List pending approvals.
 */
export function listPendingApprovals(paths: BusPaths): Approval[] {
  const pendingDir = join(paths.approvalDir, 'pending');
  let files: string[];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const approvals: Approval[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(pendingDir, file), 'utf-8');
      approvals.push(JSON.parse(content));
    } catch {
      // Skip corrupt
    }
  }

  return approvals.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
