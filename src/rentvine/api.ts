/**
 * RentVine API client — v1, read-only.
 *
 * Field-level shapes below are unverified against a live account (no
 * credentials or sandbox access as of writing). What IS confirmed, cross-
 * checked against a real open-source API wrapper's request code (not
 * official docs, which require a login this org does not have yet):
 *   - base URL is account-scoped: https://{accountCode}.rentvine.com/api/manager/{path}
 *   - auth is HTTP Basic on apiKey:apiSecret, not a single bearer token
 *   - list endpoints return a JSON array where each item wraps the real
 *     record under one known key (e.g. `workOrder`, `contact`)
 * Full research trail: knowledge/projects/rentvine-integration.md
 */

const API_TIMEOUT_MS = 10_000;

export interface RentVineAuth {
  accountCode: string;
  apiKey: string;
  apiSecret: string;
}

/** Inner field names are unverified — do not assume this list is complete. */
export interface RentVineWorkOrder {
  [field: string]: unknown;
}

/** Inner field names are unverified — do not assume this list is complete. */
export interface RentVineVendor {
  [field: string]: unknown;
}

/** Inner field names are unverified — do not assume this list is complete. */
export interface RentVineLeaseBalance {
  lease: Record<string, unknown>;
  balances: Record<string, unknown>;
  property: Record<string, unknown>;
  unit: Record<string, unknown>;
  portfolio: Record<string, unknown>;
}

/**
 * Unwraps a RentVine list response, failing loud instead of silently
 * returning undefined fields if the real API's shape turns out to differ
 * from the unverified schema this client was written against.
 */
function unwrapEnvelopeList<T>(data: unknown, key: string, path: string): T[] {
  if (!Array.isArray(data)) {
    throw new Error(`RentVine API ${path}: expected an array response, got ${typeof data}`);
  }
  return data.map((item, index) => {
    if (typeof item !== 'object' || item === null || !(key in item)) {
      throw new Error(
        `RentVine API ${path}: item ${index} is missing the expected "${key}" key — response shape ` +
        `may not match the unverified schema in knowledge/projects/rentvine-integration.md`,
      );
    }
    return (item as Record<string, T>)[key];
  });
}

export class RentVineAPI {
  private readonly auth: RentVineAuth;

  constructor(auth: RentVineAuth) {
    this.auth = auth;
  }

  private get baseUrl(): string {
    return `https://${this.auth.accountCode}.rentvine.com/api/manager`;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.auth.apiKey}:${this.auth.apiSecret}`).toString('base64')}`;
  }

  /**
   * Shared fetch wrapper: bounded timeout + HTTP-status checking before JSON
   * parsing, mirroring src/slack/api.ts. A hung call must not stall whatever
   * loop awaits it, and a 429/5xx page is often not valid JSON.
   */
  private async requestJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': this.authHeader(),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new Error(
          `RentVine API ${path} rate limited (HTTP 429${retryAfter ? `, retry after ${retryAfter}s` : ''})`,
        );
      }
      throw new Error(`RentVine API ${path} failed: HTTP ${response.status}`);
    }

    return await response.json() as T;
  }

  async workOrders(params: Record<string, string> = {}): Promise<RentVineWorkOrder[]> {
    const data = await this.requestJson<unknown>('maintenance/work-orders', params);
    return unwrapEnvelopeList<RentVineWorkOrder>(data, 'workOrder', 'maintenance/work-orders');
  }

  async workOrder(workOrderId: string): Promise<RentVineWorkOrder> {
    const path = `maintenance/work-orders/${workOrderId}`;
    const data = await this.requestJson<unknown>(path);
    if (typeof data !== 'object' || data === null || !('workOrder' in data)) {
      throw new Error(`RentVine API ${path}: response is missing the expected "workOrder" key`);
    }
    return (data as Record<string, RentVineWorkOrder>).workOrder;
  }

  async vendors(params: Record<string, string> = {}): Promise<RentVineVendor[]> {
    const data = await this.requestJson<unknown>('vendors/search', params);
    return unwrapEnvelopeList<RentVineVendor>(data, 'contact', 'vendors/search');
  }

  /**
   * There is no standalone balances endpoint. RentVine attaches a `balances`
   * object to each result of a lease export, so that is what this reads.
   */
  async leaseBalances(params: Record<string, string> = {}): Promise<RentVineLeaseBalance[]> {
    const path = 'leases/export';
    const data = await this.requestJson<unknown>(path, params);
    if (!Array.isArray(data)) {
      throw new Error(`RentVine API ${path}: expected an array response, got ${typeof data}`);
    }
    return data.map((item, index) => {
      if (typeof item !== 'object' || item === null || !('lease' in item) || !('balances' in item)) {
        throw new Error(
          `RentVine API ${path}: item ${index} is missing "lease" or "balances" — response shape ` +
          `may not match the unverified schema in knowledge/projects/rentvine-integration.md`,
        );
      }
      const record = item as Record<string, Record<string, unknown>>;
      return {
        lease: record.lease,
        balances: record.balances,
        property: record.property,
        unit: record.unit,
        portfolio: record.portfolio,
      };
    });
  }

  // No messages() method: no endpoint was found for resident/owner messages
  // during research. See knowledge/projects/rentvine-integration.md — the
  // first live-API action once credentials exist should be confirming
  // whether one exists at all before this method gets written.
}
