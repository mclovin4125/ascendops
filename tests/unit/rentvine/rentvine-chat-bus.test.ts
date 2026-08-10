import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Approval, BusPaths } from '../../../src/types/index.js';

const chatMessagesMock = vi.fn();
const postChatMessageMock = vi.fn();

vi.mock('../../../src/rentvine/api.js', () => ({
  RentVineAPI: vi.fn().mockImplementation(function (this: unknown, auth: unknown) {
    return { auth, chatMessages: chatMessagesMock, postChatMessage: postChatMessageMock };
  }),
}));

const resolveEnvMock = vi.fn();
const parseEnvFileMock = vi.fn();

vi.mock('../../../src/utils/env.js', () => ({
  resolveEnv: (...args: unknown[]) => resolveEnvMock(...args),
  parseEnvFile: (...args: unknown[]) => parseEnvFileMock(...args),
}));

function mkPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

function writeApproval(paths: BusPaths, dir: 'pending' | 'resolved', approval: Approval): void {
  const target = join(paths.approvalDir, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${approval.id}.json`), JSON.stringify(approval));
}

function baseApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval_test_1',
    title: 'Send WO chat message',
    requesting_agent: 'maintenance-director',
    org: 'lane-family-homes',
    category: 'external-comms',
    status: 'approved',
    description: '',
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    resolved_at: '2026-08-10T00:00:00Z',
    resolved_by: null,
    ...overrides,
  };
}

describe('bus/rentvine — chat: credential loading + internal-id guard', () => {
  const ORIGINAL_ENV = { ...process.env };
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RENTVINE_ACCOUNT_CODE;
    delete process.env.RENTVINE_API_KEY;
    delete process.env.RENTVINE_API_SECRET;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-rentvine-chat-test-'));
    paths = mkPaths(testDir);
    resolveEnvMock.mockReturnValue({ agentDir: '' });
    parseEnvFileMock.mockReturnValue({});
    process.env.RENTVINE_ACCOUNT_CODE = 'lfh';
    process.env.RENTVINE_API_KEY = 'k';
    process.env.RENTVINE_API_SECRET = 's';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(testDir, { recursive: true, force: true });
  });

  it('getRentVineChatMessages passes the internal id through and returns the flat rows unmodified', async () => {
    chatMessagesMock.mockResolvedValue([{ 'message.id': 1 }]);
    const { getRentVineChatMessages } = await import('../../../src/bus/rentvine.js');

    await expect(getRentVineChatMessages('58')).resolves.toEqual([{ 'message.id': 1 }]);
    expect(chatMessagesMock).toHaveBeenCalledWith(58);
  });

  it('rejects a display-number-shaped id (e.g. 100058) with a corrective error, without calling the API', async () => {
    const { getRentVineChatMessages } = await import('../../../src/bus/rentvine.js');

    await expect(getRentVineChatMessages('100058')).rejects.toThrow(/display number/);
    expect(chatMessagesMock).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric or non-positive id', async () => {
    const { getRentVineChatMessages } = await import('../../../src/bus/rentvine.js');

    await expect(getRentVineChatMessages('abc')).rejects.toThrow(/invalid work order id/);
    await expect(getRentVineChatMessages('0')).rejects.toThrow(/invalid work order id/);
    await expect(getRentVineChatMessages('-5')).rejects.toThrow(/invalid work order id/);
  });

  it('sendRentVineChatMessage in dry-run mode (default) never touches the network and returns the exact payload', async () => {
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    const result = await sendRentVineChatMessage(paths, '58', 'Pauls is on site today', { tenant: true, vendor: true });

    expect(result.mode).toBe('dry-run');
    expect(result.approvalId).toBeNull();
    expect(postChatMessageMock).not.toHaveBeenCalled();
    expect(result.payload).toEqual({
      chatObjectTypeID: 1,
      objectID: 58,
      message: '<p>Pauls is on site today</p>',
      isSharedWithTenant: 1,
      isSharedWithVendor: 1,
      isSharedWithOwner: 0,
      isSharedWithCosigner: 0,
    });
  });

  it('omitting every --to-* flag still previews an internal-only payload (flags default to 0, not skipped)', async () => {
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    const result = await sendRentVineChatMessage(paths, '58', 'internal note');

    expect(result.payload.isSharedWithTenant).toBe(0);
    expect(result.payload.isSharedWithVendor).toBe(0);
    expect(result.payload.isSharedWithOwner).toBe(0);
    expect(result.payload.isSharedWithCosigner).toBe(0);
  });

  it('escapes HTML in the message body before wrapping it in <p>', async () => {
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    const result = await sendRentVineChatMessage(paths, '58', 'Tom <b>Carroll</b> & the leak');

    expect(result.payload.message).toBe('<p>Tom &lt;b&gt;Carroll&lt;/b&gt; &amp; the leak</p>');
  });

  it('--send-real WITHOUT --approved-by is refused — this is the whole point of the build', async () => {
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    await expect(
      sendRentVineChatMessage(paths, '58', 'hello', { tenant: true }, { sendReal: true }),
    ).rejects.toThrow(/requires --approved-by/);
    expect(postChatMessageMock).not.toHaveBeenCalled();
  });

  it('--send-real with an approval id that does not exist is refused', async () => {
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    await expect(
      sendRentVineChatMessage(paths, '58', 'hello', { tenant: true }, { sendReal: true, approvedBy: 'approval_missing' }),
    ).rejects.toThrow(/not found/);
    expect(postChatMessageMock).not.toHaveBeenCalled();
  });

  it('--send-real with a PENDING (not yet decided) approval id is refused', async () => {
    writeApproval(paths, 'pending', baseApproval({ id: 'approval_pending_1', status: 'pending' }));
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    await expect(
      sendRentVineChatMessage(paths, '58', 'hello', { tenant: true }, { sendReal: true, approvedBy: 'approval_pending_1' }),
    ).rejects.toThrow(/is pending, not approved/);
    expect(postChatMessageMock).not.toHaveBeenCalled();
  });

  it('--send-real with an approval id from the WRONG category is refused', async () => {
    writeApproval(paths, 'resolved', baseApproval({ id: 'approval_wrong_cat', category: 'deployment' }));
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    await expect(
      sendRentVineChatMessage(paths, '58', 'hello', { tenant: true }, { sendReal: true, approvedBy: 'approval_wrong_cat' }),
    ).rejects.toThrow(/expected external-comms/);
    expect(postChatMessageMock).not.toHaveBeenCalled();
  });

  it('--send-real with a genuinely approved external-comms approval posts and returns mode "sent"', async () => {
    writeApproval(paths, 'resolved', baseApproval({ id: 'approval_good_1' }));
    postChatMessageMock.mockResolvedValue({ 'message.id': 999 });
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    const result = await sendRentVineChatMessage(
      paths, '58', 'Pauls is on site today', { tenant: true, vendor: true },
      { sendReal: true, approvedBy: 'approval_good_1' },
    );

    expect(result.mode).toBe('sent');
    expect(result.approvalId).toBe('approval_good_1');
    expect(result.response).toEqual({ 'message.id': 999 });
    expect(postChatMessageMock).toHaveBeenCalledWith({
      chatObjectTypeID: 1,
      objectID: 58,
      message: '<p>Pauls is on site today</p>',
      isSharedWithTenant: 1,
      isSharedWithVendor: 1,
      isSharedWithOwner: 0,
      isSharedWithCosigner: 0,
    });
  });

  it('a real send is gated even when every --to-* flag is omitted (internal-only is not exempt from the approval check)', async () => {
    const { sendRentVineChatMessage } = await import('../../../src/bus/rentvine.js');

    await expect(
      sendRentVineChatMessage(paths, '58', 'internal reasoning note', {}, { sendReal: true }),
    ).rejects.toThrow(/requires --approved-by/);
    expect(postChatMessageMock).not.toHaveBeenCalled();
  });
});
