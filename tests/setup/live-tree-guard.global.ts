import { decide, detectLiveTree, getRepoRoot } from '../../scripts/prebuild-guard.mjs';
import { execFileSync } from 'child_process';

// `npm test`'s pretest hook runs this same guard, but `npx vitest run`
// (or `npx vitest` directly) skips npm lifecycle hooks entirely. Without
// this, that bypass can run tests/unit/build-output.test.ts against the
// live checkout the global `cortextos` binary resolves into, rebuilding
// its dist/ from whatever branch is checked out (see 2026-10-21 incident).
export function setup(): void {
  const repoRoot = getRepoRoot();
  const detection = detectLiveTree(repoRoot);
  let branch = 'detached';
  try {
    branch = execFileSync('git', ['-C', repoRoot, 'branch', '--show-current'], {
      encoding: 'utf-8',
    }).trim() || 'detached';
  } catch {
    // leave branch as 'detached'
  }

  const decision = decide({
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
    live: detection.live,
    branch,
    override: process.env.ALLOW_FEATURE_BUILD === '1',
  });

  if (!decision.allow) {
    throw new Error(
      [
        `[vitest-live-guard] refusing to run the test suite directly in the live checkout on branch ${branch}.`,
        'This tree is what the global `cortextos` binary resolves into; a direct `vitest` run skips npm\'s pretest guard.',
        'Switch to main, or run tests from an isolated git worktree instead.',
        ...decision.messages,
      ].join('\n'),
    );
  }
}
