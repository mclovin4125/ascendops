/**
 * hook-rentvine-approval-gate.ts — PreToolUse hook: requires a real, recently
 * resolved approval before an external-facing RentVine MCP write proceeds.
 *
 * Follow-up from analyst's 2026-08-12 authorization-incidents audit
 * (orgs/lane-family-homes/agents/analyst/memory/audits/2026-08-12-authorization-incidents-audit.md,
 * incident 1): maintenance-director called `send_rentvine_feedback` based on
 * a relayed "go ahead" that Mack never actually gave — no approval record
 * existed at all. Unlike send-sms/rentvine-chat-send (both gated in bus/*.ts
 * with a hard --approved-by check), the RentVine MCP tools are raw third-
 * party calls with no equivalent code-level enforcement, and the fleet runs
 * `--dangerously-skip-permissions`, so there is no permission-prompt
 * backstop either.
 *
 * Mechanism: MCP tools (being a third party's schema, not ours) have no
 * --approved-by parameter to hang a check on, so this hook checks a weaker
 * but real and independently verifiable condition instead of trusting the
 * agent's self-report: has THIS agent had an approval genuinely resolved
 * (status=approved, via the same resolver!=requester-enforced updateApproval
 * path — see bus/approval.ts) in a relevant category, recently? If not,
 * block. This directly closes the "zero approval existed at all" gap the
 * incident exploited. It is not single-use/per-call consumption (see
 * RECENT_WINDOW_MS below) — a possible future hardening if this proves
 * insufficient, called out explicitly rather than silently scoped out.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import type { Approval, BusPaths } from '../types/index.js';
import { readStdin, parseHookInput } from './index.js';

/**
 * Tool names this gate applies to. Currently just the one named in the
 * incident. Other external-facing mcp__rentvine__* write tools were
 * audited (see the audit doc above) but not gated here — add a name to
 * this set to extend coverage; the check logic doesn't need to change.
 */
export const GATED_RENTVINE_TOOLS = new Set([
  'mcp__rentvine__send_rentvine_feedback',
]);

/** Approval categories that count as authorizing a gated call. */
const ACCEPTED_CATEGORIES = new Set(['external-comms', 'other']);

/**
 * How recent a resolved approval must be to count. Deliberately generous
 * (not single-use) — the incident this closes is "zero approval existed",
 * not "the same approval got reused an hour later". 2h keeps it clearly
 * tied to "just now" without forcing a fresh approval per closely-related
 * follow-up call in the same work session.
 */
export const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface GateCheckResult {
  allowed: boolean;
  reason?: string;
}

function loadResolvedApprovals(paths: BusPaths): Approval[] {
  const dir = join(paths.approvalDir, 'resolved');
  if (!existsSync(dir)) return [];
  const out: Approval[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
    } catch {
      // Skip corrupt records — same tolerance as listPendingApprovals.
    }
  }
  return out;
}

/**
 * Core check, exported and pure (paths/agentName/toolName/now all passed
 * in) so it's testable without stdin/stdout/env plumbing.
 */
export function checkGate(
  paths: BusPaths,
  agentName: string,
  toolName: string,
  nowMs: number = Date.now(),
): GateCheckResult {
  if (!GATED_RENTVINE_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  const resolved = loadResolvedApprovals(paths);
  const hasRecentApproval = resolved.some((a) => {
    if (a.requesting_agent !== agentName) return false;
    if (a.status !== 'approved') return false;
    if (!ACCEPTED_CATEGORIES.has(a.category)) return false;
    if (!a.resolved_at) return false;
    const age = nowMs - Date.parse(a.resolved_at);
    return Number.isFinite(age) && age >= 0 && age <= RECENT_WINDOW_MS;
  });

  if (!hasRecentApproval) {
    return {
      allowed: false,
      reason:
        `Blocked: "${toolName}" is an external-facing RentVine write (2026-08-12 incident: this ` +
        'exact tool was called on a relayed "go ahead" that Mack never actually gave — no approval ' +
        'record existed). It now requires a resolved, approved approval (category external-comms or ' +
        'other) resolved in the last 2 hours before this call. Create one with `cortextos bus ' +
        'create-approval`, get it resolved by Mack — not self-resolved, updateApproval already refuses ' +
        'that — then retry.',
    };
  }

  return { allowed: true };
}

function blockCall(reason: string): void {
  const output = { decision: 'block', reason };
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(0);
}

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name } = parseHookInput(input);

  if (!GATED_RENTVINE_TOOLS.has(tool_name)) {
    process.exit(0);
    return;
  }

  const env = resolveEnv();
  const paths = resolvePaths(env.agentName, env.instanceId, env.org);
  const result = checkGate(paths, env.agentName, tool_name);

  if (!result.allowed) {
    blockCall(result.reason ?? `Blocked: ${tool_name} requires a resolved approval.`);
    return;
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
