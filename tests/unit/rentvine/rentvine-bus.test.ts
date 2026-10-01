import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const workOrdersMock = vi.fn();
const vendorsMock = vi.fn();
const leaseBalancesMock = vi.fn();

vi.mock('../../../src/rentvine/api.js', () => ({
  RentVineAPI: vi.fn().mockImplementation(function (this: unknown, auth: unknown) {
    return { auth, workOrders: workOrdersMock, vendors: vendorsMock, leaseBalances: leaseBalancesMock };
  }),
}));

const resolveEnvMock = vi.fn();
const parseEnvFileMock = vi.fn();

vi.mock('../../../src/utils/env.js', () => ({
  resolveEnv: (...args: unknown[]) => resolveEnvMock(...args),
  parseEnvFile: (...args: unknown[]) => parseEnvFileMock(...args),
}));

describe('bus/rentvine — credential loading', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RENTVINE_ACCOUNT_CODE;
    delete process.env.RENTVINE_API_KEY;
    delete process.env.RENTVINE_API_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws a descriptive error when no credentials are configured anywhere', async () => {
    resolveEnvMock.mockReturnValue({ agentDir: '' });
    parseEnvFileMock.mockReturnValue({});
    const { getRentVineWorkOrders } = await import('../../../src/bus/rentvine.js');

    await expect(getRentVineWorkOrders()).rejects.toThrow(
      /RENTVINE_ACCOUNT_CODE, RENTVINE_API_KEY, and RENTVINE_API_SECRET/,
    );
  });

  it('reads credentials from the agent .env file when present', async () => {
    resolveEnvMock.mockReturnValue({ agentDir: '/orgs/lane-family-homes/agents/maintenance-director' });
    parseEnvFileMock.mockReturnValue({
      RENTVINE_ACCOUNT_CODE: 'lfh',
      RENTVINE_API_KEY: 'key-from-file',
      RENTVINE_API_SECRET: 'secret-from-file',
    });
    workOrdersMock.mockResolvedValue([{ id: 1 }]);
    const { RentVineAPI } = await import('../../../src/rentvine/api.js');
    const { getRentVineWorkOrders } = await import('../../../src/bus/rentvine.js');

    const result = await getRentVineWorkOrders();

    expect(result).toEqual([{ id: 1 }]);
    expect(RentVineAPI).toHaveBeenCalledWith({
      accountCode: 'lfh',
      apiKey: 'key-from-file',
      apiSecret: 'secret-from-file',
    });
  });

  it('falls back to process.env when the agent .env file has nothing', async () => {
    resolveEnvMock.mockReturnValue({ agentDir: '' });
    parseEnvFileMock.mockReturnValue({});
    process.env.RENTVINE_ACCOUNT_CODE = 'lfh-env';
    process.env.RENTVINE_API_KEY = 'key-from-env';
    process.env.RENTVINE_API_SECRET = 'secret-from-env';
    vendorsMock.mockResolvedValue([]);
    const { RentVineAPI } = await import('../../../src/rentvine/api.js');
    const { getRentVineVendors } = await import('../../../src/bus/rentvine.js');

    await getRentVineVendors();

    expect(RentVineAPI).toHaveBeenCalledWith({
      accountCode: 'lfh-env',
      apiKey: 'key-from-env',
      apiSecret: 'secret-from-env',
    });
  });

  it('getRentVineLeaseBalances delegates to the client', async () => {
    resolveEnvMock.mockReturnValue({ agentDir: '' });
    parseEnvFileMock.mockReturnValue({});
    process.env.RENTVINE_ACCOUNT_CODE = 'lfh';
    process.env.RENTVINE_API_KEY = 'k';
    process.env.RENTVINE_API_SECRET = 's';
    leaseBalancesMock.mockResolvedValue([{ lease: {}, balances: {} }]);
    const { getRentVineLeaseBalances } = await import('../../../src/bus/rentvine.js');

    await expect(getRentVineLeaseBalances()).resolves.toEqual([{ lease: {}, balances: {} }]);
  });

  it('getRentVineWorkOrders walks pages past the 15-newest default and filters to open-only', async () => {
    resolveEnvMock.mockReturnValue({ agentDir: '' });
    parseEnvFileMock.mockReturnValue({});
    process.env.RENTVINE_ACCOUNT_CODE = 'lfh';
    process.env.RENTVINE_API_KEY = 'k';
    process.env.RENTVINE_API_SECRET = 's';

    const fullPage = Array.from({ length: 100 }, (_, i) => ({ workOrderID: i + 1, dateClosed: null }));
    const shortPage = [
      { workOrderID: 101, dateClosed: null },
      { workOrderID: 102, dateClosed: '2026-01-01' },
    ];
    workOrdersMock.mockResolvedValueOnce(fullPage).mockResolvedValueOnce(shortPage);
    const { getRentVineWorkOrders } = await import('../../../src/bus/rentvine.js');

    const result = await getRentVineWorkOrders();

    expect(workOrdersMock).toHaveBeenCalledTimes(2);
    expect(workOrdersMock).toHaveBeenNthCalledWith(1, { pageSize: '100', page: '1' });
    expect(workOrdersMock).toHaveBeenNthCalledWith(2, { pageSize: '100', page: '2' });
    expect(result).toHaveLength(101);
    expect(result.map((wo) => wo.workOrderID)).toContain(101);
    expect(result.map((wo) => wo.workOrderID)).not.toContain(102);
  });

  it('getRentVineWorkOrders stops after a single short page', async () => {
    resolveEnvMock.mockReturnValue({ agentDir: '' });
    parseEnvFileMock.mockReturnValue({});
    process.env.RENTVINE_ACCOUNT_CODE = 'lfh';
    process.env.RENTVINE_API_KEY = 'k';
    process.env.RENTVINE_API_SECRET = 's';
    workOrdersMock.mockResolvedValueOnce([{ workOrderID: 1, dateClosed: null }]);
    const { getRentVineWorkOrders } = await import('../../../src/bus/rentvine.js');

    const result = await getRentVineWorkOrders();

    expect(workOrdersMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ workOrderID: 1, dateClosed: null }]);
  });
});
