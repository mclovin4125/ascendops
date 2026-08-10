import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Approval, BusPaths } from '../types/index.js';
import { resolveEnv, parseEnvFile } from '../utils/env.js';
import { redactSSN } from '../utils/ssn-redaction.js';
import {
  RentVineAPI,
  type RentVineAuth,
  type RentVineWorkOrder,
  type RentVineVendor,
  type RentVineLeaseBalance,
  type RentVineChatMessage,
  type RentVineChatMessagePayload,
} from '../rentvine/api.js';

/**
 * Reads RENTVINE_ACCOUNT_CODE/API_KEY/API_SECRET from the calling agent's
 * .env, falling back to process.env. Credentials live per-agent (currently
 * planned for maintenance-director's .env), same pattern as SLACK_BOT_TOKEN.
 */
function loadRentVineAuth(): RentVineAuth {
  const env = resolveEnv();
  const fileVars = env.agentDir ? parseEnvFile(join(env.agentDir, '.env')) : {};

  const accountCode = fileVars.RENTVINE_ACCOUNT_CODE || process.env.RENTVINE_ACCOUNT_CODE;
  const apiKey = fileVars.RENTVINE_API_KEY || process.env.RENTVINE_API_KEY;
  const apiSecret = fileVars.RENTVINE_API_SECRET || process.env.RENTVINE_API_SECRET;

  if (!accountCode || !apiKey || !apiSecret) {
    // env.agentDir only resolves when the shell carries agent context (CTX_AGENT_DIR
    // directly, or enough of CTX_ORG/CTX_PROJECT_ROOT/CORTEXTOS_DIR to derive it — see
    // resolveEnv in utils/env.ts). A shell with none of that (an operator's plain
    // terminal, or any script invoked outside an agent's own session) resolves
    // agentDir to '', so the .env read above is silently skipped. Confirmed
    // 2026-08-07: that read identically to a genuinely missing/incomplete .env file
    // — "RentVine credentials missing" — even when the credentials are present and
    // valid on disk, because the command was never looking in the right place. Name
    // that distinction rather than reporting a plain data-missing error in both cases.
    if (!env.agentDir) {
      throw new Error(
        'RentVine credentials missing, AND no agent directory could be resolved for this shell ' +
        '(no CTX_AGENT_DIR, and not enough of CTX_ORG/CTX_PROJECT_ROOT to derive one) — an agent ' +
        '.env file was never checked. Run this from an agent session context (or export ' +
        'CTX_AGENT_NAME, CTX_ORG, and CTX_ROOT/CORTEXTOS_DIR) before concluding credentials are ' +
        'actually missing, or set RENTVINE_ACCOUNT_CODE, RENTVINE_API_KEY, and RENTVINE_API_SECRET ' +
        'directly in the environment.',
      );
    }
    throw new Error(
      `RentVine credentials missing from ${env.agentDir}/.env. Set RENTVINE_ACCOUNT_CODE, ` +
      'RENTVINE_API_KEY, and RENTVINE_API_SECRET in your agent .env file.',
    );
  }

  return { accountCode, apiKey, apiSecret };
}

// async, not just Promise-returning: loadRentVineAuth() throws synchronously
// on missing credentials, and callers expect a rejected promise (these are
// documented as async operations), not a synchronous throw out of a
// nominally Promise-returning function.
export async function getRentVineWorkOrders(): Promise<RentVineWorkOrder[]> {
  return new RentVineAPI(loadRentVineAuth()).workOrders();
}

export async function getRentVineVendors(): Promise<RentVineVendor[]> {
  return new RentVineAPI(loadRentVineAuth()).vendors();
}

export async function getRentVineLeaseBalances(): Promise<RentVineLeaseBalance[]> {
  return new RentVineAPI(loadRentVineAuth()).leaseBalances();
}

/**
 * RentVine's chat API takes the internal workOrderID (e.g. 58), not the
 * display number shown to humans (e.g. #100058) — mixing these up is the
 * single easiest way to misuse this endpoint (confirmed in the research
 * artifact). Display numbers in this account run 100000+; real internal
 * ids do not. This is a heuristic safety net, not a lookup — it catches the
 * common slip without needing a number->id translation table.
 */
function assertInternalWorkOrderId(workOrderId: string): number {
  const n = Number(workOrderId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `invalid work order id "${workOrderId}" — expected RentVine's internal workOrderID ` +
      '(a positive integer, e.g. 58), not the display number (e.g. #100058).',
    );
  }
  if (n >= 10000) {
    throw new Error(
      `work order id ${workOrderId} looks like a display number (RentVine shows those as ` +
      '#100000+), not the internal workOrderID the chat API needs. Look up the internal id ' +
      '(e.g. via rentvine-work-orders) and pass that instead.',
    );
  }
  return n;
}

/**
 * Read a work-order chat thread. Read-only, gated by nothing but RentVine
 * credentials — the send path below is what carries the approval gate.
 *
 * Side effect per RentVine (verified): retrieving messages marks them read
 * by the manager role. Call this on demand only; do not wrap it in a
 * polling loop without accounting for that.
 */
export async function getRentVineChatMessages(workOrderId: string): Promise<RentVineChatMessage[]> {
  const objectID = assertInternalWorkOrderId(workOrderId);
  return new RentVineAPI(loadRentVineAuth()).chatMessages(objectID);
}

export interface RentVineChatShareFlags {
  tenant?: boolean;
  vendor?: boolean;
  owner?: boolean;
  cosigner?: boolean;
}

export interface SendRentVineChatMessageResult {
  ok: boolean;
  mode: 'dry-run' | 'sent';
  approvalId: string | null;
  workOrderId: string;
  message: string;
  payload: RentVineChatMessagePayload;
  response?: RentVineChatMessage;
}

/** Sibling of validateSmsApproval in send-sms.ts — same shape, not shared
 * across modules because neither approval check has grown a second variant
 * yet. If a third external-comms channel needs this, factor out then. */
function loadApproval(paths: BusPaths, approvalId: string): Approval {
  const candidates = [
    join(paths.approvalDir, 'resolved', `${approvalId}.json`),
    join(paths.approvalDir, 'pending', `${approvalId}.json`),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    return JSON.parse(readFileSync(file, 'utf-8')) as Approval;
  }
  throw new Error(`approval ${approvalId} not found`);
}

export function validateRentVineChatApproval(paths: BusPaths, approvalId: string): Approval {
  const approval = loadApproval(paths, approvalId);
  if (approval.status !== 'approved') {
    throw new Error(`approval ${approvalId} is ${approval.status}, not approved`);
  }
  if (approval.category !== 'external-comms') {
    throw new Error(`approval ${approvalId} category is ${approval.category}, expected external-comms`);
  }
  return approval;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Post into a work-order chat thread. Safe-by-default, mirroring sendSms:
 * without --send-real this only returns the payload that WOULD be posted,
 * no network write. A real post additionally requires an approved
 * external-comms approval id — checked EVERY time, regardless of which
 * parties the message is shared with (an omitted share flag still posts
 * to the WO record, so there is no "purely internal, skip the gate" case
 * here; the whole point of this build is that a real send cannot happen
 * quietly). See knowledge/ops/rentvine-chat-api.md for the "notify nobody"
 * incident this replaces.
 */
export async function sendRentVineChatMessage(
  paths: BusPaths,
  workOrderId: string,
  message: string,
  shareFlags: RentVineChatShareFlags = {},
  opts: { sendReal?: boolean; approvedBy?: string } = {},
): Promise<SendRentVineChatMessageResult> {
  const objectID = assertInternalWorkOrderId(workOrderId);
  // Scrub at the egress primitive, same as sendSms — never SHARE/STORE an
  // SSN in a chat message, and never surface one in the dry-run preview.
  message = redactSSN(message);

  const payload: RentVineChatMessagePayload = {
    chatObjectTypeID: 1,
    objectID,
    message: `<p>${escapeHtml(message)}</p>`,
    isSharedWithTenant: shareFlags.tenant ? 1 : 0,
    isSharedWithVendor: shareFlags.vendor ? 1 : 0,
    isSharedWithOwner: shareFlags.owner ? 1 : 0,
    isSharedWithCosigner: shareFlags.cosigner ? 1 : 0,
  };

  if (!opts.sendReal) {
    return {
      ok: true,
      mode: 'dry-run',
      approvalId: opts.approvedBy ?? null,
      workOrderId,
      message,
      payload,
    };
  }

  if (!opts.approvedBy) {
    throw new Error('live chat send requires --approved-by <approval_id>');
  }

  validateRentVineChatApproval(paths, opts.approvedBy);

  const response = await new RentVineAPI(loadRentVineAuth()).postChatMessage(payload);

  return {
    ok: true,
    mode: 'sent',
    approvalId: opts.approvedBy,
    workOrderId,
    message,
    payload,
    response,
  };
}
