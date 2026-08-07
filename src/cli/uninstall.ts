import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

/**
 * Count pending approvals and non-terminal tasks across every org under
 * `ctxRoot`. Both live ONLY in this state directory — a plain `rmSync`
 * here (the default uninstall path) removes them with nothing in the live
 * system pointing at where they went, even if an external backup exists.
 * Confirmed live 2026-08-07: an uninstall/rebuild appeared to have wiped 3
 * pending approvals. They turned out to still exist in an archive copy of
 * the prior state directory, but nothing running pointed to it, so from
 * inside the live instance they were indistinguishable from actually
 * gone — an unfindable backup does not help during live recovery.
 *
 * Best-effort: a malformed or unreadable JSON file is skipped rather than
 * thrown, since this is a pre-flight warning, not a data integrity check.
 */
export function countPendingState(ctxRoot: string): { approvals: number; tasks: number } {
  const orgsDir = join(ctxRoot, 'orgs');
  let approvals = 0;
  let tasks = 0;
  if (!existsSync(orgsDir)) return { approvals, tasks };

  let orgNames: string[];
  try {
    orgNames = readdirSync(orgsDir).filter(name => {
      try {
        return statSync(join(orgsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return { approvals, tasks };
  }

  for (const org of orgNames) {
    const pendingApprovalsDir = join(orgsDir, org, 'approvals', 'pending');
    if (existsSync(pendingApprovalsDir)) {
      try {
        approvals += readdirSync(pendingApprovalsDir).filter(f => f.endsWith('.json')).length;
      } catch { /* best-effort */ }
    }

    const tasksDir = join(orgsDir, org, 'tasks');
    if (existsSync(tasksDir)) {
      try {
        for (const file of readdirSync(tasksDir)) {
          if (!file.endsWith('.json')) continue;
          try {
            const task = JSON.parse(readFileSync(join(tasksDir, file), 'utf-8'));
            if (task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked') {
              tasks += 1;
            }
          } catch { /* skip malformed task file */ }
        }
      } catch { /* best-effort */ }
    }
  }

  return { approvals, tasks };
}

export const uninstallCommand = new Command('uninstall')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--force', 'Skip the pending-approvals/tasks safety check')
  .option('--keep-state', 'Remove agent config but preserve state directory (logs, tasks, heartbeats)')
  .description('Remove AscendOps state directories and PM2 processes')
  .action(async (options: { instance: string; force?: boolean; keepState?: boolean }) => {
    const instanceId = options.instance;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);

    if (!existsSync(ctxRoot)) {
      console.log(`No AscendOps state found at ${ctxRoot}`);
      return;
    }

    // The full-removal path (no --keep-state) removes pending approvals and
    // tasks with nothing live pointing at where they went — they live only
    // here, not in the framework git repo, and even a manual backup of this
    // directory is unfindable from inside the running system unless someone
    // remembers to look for it. Block by default so this can't happen
    // silently; --force or --keep-state both opt out explicitly.
    if (!options.keepState && !options.force) {
      const pending = countPendingState(ctxRoot);
      if (pending.approvals > 0 || pending.tasks > 0) {
        console.error(`\n  BLOCKED: found ${pending.approvals} pending approval(s) and ${pending.tasks} open task(s) under ${ctxRoot}.`);
        console.error('  These exist only in this state directory — removing it leaves nothing live pointing at them, even if you back the directory up first.');
        console.error('  Resolve them first, re-run with --force to remove anyway, or use --keep-state to preserve state instead.\n');
        process.exitCode = 1;
        return;
      }
    }

    console.log(`\nUninstalling AscendOps instance: ${instanceId}`);
    console.log(`  State directory: ${ctxRoot}`);
    if (options.keepState) {
      console.log('  Mode: --keep-state (preserving state directory, removing agent config only)\n');
    } else {
      console.log('');
    }

    // Stop PM2 processes if pm2 is available
    try {
      const pm2Result = spawnSync('pm2', ['jlist'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
      if (pm2Result.status === 0 && pm2Result.stdout) {
        const processes = JSON.parse(pm2Result.stdout);
        const cortextosProcesses = processes.filter((p: { name: string }) =>
          p.name.startsWith('cortextos-') || p.name.startsWith(`ctx-${instanceId}`),
        );
        for (const p of cortextosProcesses) {
          const del = spawnSync('pm2', ['delete', p.name], { timeout: 5000, stdio: 'pipe' });
          if (del.status === 0) {
            console.log(`  Stopped PM2 process: ${p.name}`);
          }
        }
      }
    } catch {
      // PM2 not available, skip
    }

    if (options.keepState) {
      // --keep-state: remove only enabled-agents config, preserve all state data
      const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
      if (existsSync(enabledFile)) {
        try {
          rmSync(enabledFile);
          console.log('  Removed enabled-agents.json');
        } catch { /* ignore */ }
      }
      console.log('  Preserved state directory (logs, tasks, heartbeats, analytics)');
    } else {
      // Full uninstall: remove entire state directory
      try {
        rmSync(ctxRoot, { recursive: true, force: true });
        console.log(`  Removed state directory: ${ctxRoot}`);
      } catch (err) {
        console.error(`  Failed to remove ${ctxRoot}: ${err}`);
      }
    }

    // Remove ecosystem.config.js if exists in current directory
    const ecosystemPath = join(process.cwd(), 'ecosystem.config.js');
    if (existsSync(ecosystemPath)) {
      try {
        rmSync(ecosystemPath);
        console.log('  Removed ecosystem.config.js');
      } catch { /* ignore */ }
    }

    console.log('\n  AscendOps uninstalled.');
  });
