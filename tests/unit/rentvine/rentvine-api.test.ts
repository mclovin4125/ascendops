import { describe, it, expect, vi, afterEach } from 'vitest';
import { RentVineAPI } from '../../../src/rentvine/api.js';

const AUTH = { accountCode: 'acme', apiKey: 'key123', apiSecret: 'secret456' };

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function httpError(status: number, retryAfter?: string) {
  return {
    ok: false,
    status,
    headers: {
      get: (name: string) =>
        retryAfter && name.toLowerCase() === 'retry-after' ? retryAfter : null,
    },
    // Transport-level errors are often NOT JSON (proxy HTML, empty bodies) —
    // parsing must never be reached for them.
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  };
}

describe('RentVineAPI — transport and auth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hits the account-scoped subdomain with Basic auth on apiKey:apiSecret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([{ workOrder: { id: 1 } }]));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RentVineAPI(AUTH);

    await api.workOrders();

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://acme.rentvine.com/api/manager/maintenance/work-orders');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from('key123:secret456').toString('base64')}`);
  });

  it('every call carries an abort signal (bounded timeout — a hung call must not stall the caller)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([{ contact: { id: 1 } }]));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RentVineAPI(AUTH);

    await api.vendors();

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces HTTP 429 with the Retry-After value instead of an opaque JSON parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(429, '12')));
    const api = new RentVineAPI(AUTH);

    await expect(api.workOrders()).rejects.toThrow(/rate limited.*429.*retry after 12s/i);
  });

  it('surfaces a non-OK HTTP status descriptively (5xx/proxy pages are not JSON)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(502)));
    const api = new RentVineAPI(AUTH);

    await expect(api.vendors()).rejects.toThrow(/HTTP 502/);
  });

  it('passes query params through the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([{ contact: { id: 1 } }]));
    vi.stubGlobal('fetch', fetchMock);
    const api = new RentVineAPI(AUTH);

    await api.vendors({ trade: 'plumbing' });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get('trade')).toBe('plumbing');
  });
});

describe('RentVineAPI — response shape validation (fail loud, not silently wrong)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('workOrders unwraps the workOrder envelope on each list item', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse([{ workOrder: { id: 1 } }, { workOrder: { id: 2 } }])),
    );
    const api = new RentVineAPI(AUTH);

    await expect(api.workOrders()).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('workOrders throws if the response is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ workOrder: { id: 1 } })));
    const api = new RentVineAPI(AUTH);

    await expect(api.workOrders()).rejects.toThrow(/expected an array response/);
  });

  it('workOrders throws if a list item is missing the workOrder key (shape drift)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([{ unexpected: true }])));
    const api = new RentVineAPI(AUTH);

    await expect(api.workOrders()).rejects.toThrow(/missing the expected "workOrder" key/);
  });

  it('vendors unwraps the contact envelope on each list item', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([{ contact: { id: 9, name: 'Acme Plumbing' } }])));
    const api = new RentVineAPI(AUTH);

    await expect(api.vendors()).resolves.toEqual([{ id: 9, name: 'Acme Plumbing' }]);
  });

  it('workOrder (single) unwraps the workOrder key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ workOrder: { id: 5 } })));
    const api = new RentVineAPI(AUTH);

    await expect(api.workOrder('5')).resolves.toEqual({ id: 5 });
  });

  it('leaseBalances returns lease + balances + property + unit + portfolio per item', async () => {
    const item = {
      lease: { id: 1, tenants: [] },
      balances: { pastDueTotalAmount: 100 },
      property: { id: 2 },
      unit: { id: 3 },
      portfolio: { id: 4 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([item])));
    const api = new RentVineAPI(AUTH);

    await expect(api.leaseBalances()).resolves.toEqual([item]);
  });

  it('leaseBalances throws if an item is missing lease or balances (shape drift)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([{ lease: {} }])));
    const api = new RentVineAPI(AUTH);

    await expect(api.leaseBalances()).rejects.toThrow(/missing "lease" or "balances"/);
  });
});
