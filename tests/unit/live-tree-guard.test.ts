import { afterEach, describe, expect, it, vi } from 'vitest';

const detectLiveTree = vi.fn();
const decide = vi.fn();
const getRepoRoot = vi.fn(() => '/repo');

vi.mock('../../scripts/prebuild-guard.mjs', () => ({
  detectLiveTree: (...args: unknown[]) => detectLiveTree(...args),
  decide: (...args: unknown[]) => decide(...args),
  getRepoRoot: (...args: unknown[]) => getRepoRoot(...args),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => 'feature/blocked-branch\n'),
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('vitest live-tree guard (globalSetup)', () => {
  it('throws when the guard blocks a live feature-branch run', async () => {
    detectLiveTree.mockReturnValue({ live: true, signals: ['D1 global-package identity'], errors: [] });
    decide.mockReturnValue({
      allow: false,
      code: 'live-feature-blocked',
      messages: ['BLOCKED: refusing to build the live checkout from branch feature/blocked-branch.'],
    });

    const { setup } = await import('../setup/live-tree-guard.global');
    expect(() => setup()).toThrowError(/refusing to run the test suite directly in the live checkout/);
  });

  it('does not throw for an isolated checkout', async () => {
    detectLiveTree.mockReturnValue({ live: false, signals: [], errors: [] });
    decide.mockReturnValue({ allow: true, code: 'isolated', messages: ['Build allowed in isolated checkout.'] });

    const { setup } = await import('../setup/live-tree-guard.global');
    expect(() => setup()).not.toThrow();
  });

  it('does not throw for the live checkout on main', async () => {
    detectLiveTree.mockReturnValue({ live: true, signals: ['D1 global-package identity'], errors: [] });
    decide.mockReturnValue({ allow: true, code: 'live-main', messages: ['Build allowed in live main checkout.'] });

    const { setup } = await import('../setup/live-tree-guard.global');
    expect(() => setup()).not.toThrow();
  });
});
