import { join } from 'path';
import { resolveEnv, parseEnvFile } from '../utils/env.js';
import {
  RentVineAPI,
  type RentVineAuth,
  type RentVineWorkOrder,
  type RentVineVendor,
  type RentVineLeaseBalance,
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
