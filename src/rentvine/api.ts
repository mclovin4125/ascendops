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
 * Rows come back flat (dot-notation field names per RentVine's docs, e.g.
 * `message.id`, `user.name`), not wrapped in an envelope key like
 * workOrder/vendor are — so this is NOT run through unwrapEnvelopeList.
 * See orgs/lane-family-homes/agents/maintenance-director/knowledge/ops/rentvine-chat-api.md.
 */
export interface RentVineChatMessage {
  [field: string]: unknown;
}

/** Payload for POST /chat/messages. Sharing flags default to 0/false server-side
 * when omitted — an omitted flag means the message is posted internal-only. */
export interface RentVineChatMessagePayload {
  chatObjectTypeID: number; // 1=Work Order, 2=Lease, 3=Portfolio, 4=Vendor, 5=Applicant
  objectID: number;         // the internal id (e.g. workOrderID), NOT a display number
  message: string;          // HTML body
  isSharedWithTenant?: 0 | 1;
  isSharedWithVendor?: 0 | 1;
  isSharedWithOwner?: 0 | 1;
  isSharedWithCosigner?: 0 | 1;
  attachments?: number[];
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

  /**
   * Shared POST wrapper, sibling of requestJson. Only used by writes (chat
   * messages today); reads stay on requestJson/GET.
   */
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = await response.text();
    }

    if (!response.ok) {
      throw new Error(
        `RentVine API POST ${path} failed: HTTP ${response.status}: ` +
        (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)),
      );
    }

    return responseBody as T;
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

  /**
   * Read a work-order chat thread — GET /chat/messages.
   *
   * NOTE: this is a manager-role read, and RentVine auto-marks retrieved
   * messages as read by the manager role as a side effect (verified,
   * see the ops doc). Do not wrap this in a background poller without
   * accounting for that — a polling loop would silently clear unread state
   * for whoever's UI shows it. This client only exposes an on-demand read;
   * no poller is built here.
   */
  async chatMessages(objectID: number, params: Record<string, string> = {}): Promise<RentVineChatMessage[]> {
    const path = 'chat/messages';
    const data = await this.requestJson<unknown>(path, {
      chatObjectTypeID: '1', // Work Order
      objectID: String(objectID),
      ...params,
    });
    if (!Array.isArray(data)) {
      throw new Error(`RentVine API ${path}: expected an array response, got ${typeof data}`);
    }
    return data as RentVineChatMessage[];
  }

  /**
   * Post into a work-order chat thread — POST /chat/messages. This is the
   * one call in this client that can reach a real tenant/vendor/owner; the
   * bus layer (src/bus/rentvine.ts) is what gates a real send behind an
   * approval id. This method itself performs no gating — do not call it
   * directly from anywhere that skips that gate.
   */
  async postChatMessage(payload: RentVineChatMessagePayload): Promise<RentVineChatMessage> {
    return this.postJson<RentVineChatMessage>('chat/messages', payload);
  }
}
