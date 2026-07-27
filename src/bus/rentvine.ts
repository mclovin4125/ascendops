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
    throw new Error(
      'RentVine credentials missing. Set RENTVINE_ACCOUNT_CODE, RENTVINE_API_KEY, and ' +
      'RENTVINE_API_SECRET in your agent .env file.',
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
