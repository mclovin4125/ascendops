import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { listAgents } from '../bus/agents.js';
import { IPCClient } from '../daemon/ipc-server.js';
import type { AgentInfo, AgentStatus } from '../types/index.js';
import { pad } from '../utils/format.js';

// listAgents() infers `running` purely from heartbeat staleness (age < 10min),
// which disagrees with `cortextos status` — the daemon's live PID-tracked
// view, which is authoritative. An agent mid-task with no heartbeat in the
// last 10 minutes reads as falsely "stopped" here; an agent that crashed
// right after a heartbeat reads as falsely "running". When the daemon is
// reachable, its live status always wins for any agent it knows about.
export function reconcileWithLiveStatus(agents: AgentInfo[], liveStatuses: AgentStatus[]): AgentInfo[] {
  const liveByName = new Map(liveStatuses.map(s => [s.name, s]));
  return agents.map(a => {
    const live = liveByName.get(a.name);
    if (!live) return a;
    return { ...a, running: live.status === 'running' };
  });
}

export const listAgentsCommand = new Command('list-agents')
  .description('List all agents in the system')
  .option('--org <org>', 'Filter by organization')
  .option('--format <format>', 'Output format: json or text', 'text')
  .option('--instance <id>', 'Instance ID')
  .action(async (options: { org?: string; format: string; instance?: string }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    let agents = listAgents(ctxRoot, options.org);

    try {
      const ipc = new IPCClient(instanceId);
      if (await ipc.isDaemonRunning()) {
        const response = await ipc.send({ type: 'status', source: 'cortextos list-agents' });
        if (response.success) {
          agents = reconcileWithLiveStatus(agents, response.data as AgentStatus[]);
        }
      }
    } catch {
      // Daemon unreachable — fall back to the heartbeat-staleness inference
      // from listAgents() above, same as `cortextos status` does.
    }

    if (options.format === 'json') {
      console.log(JSON.stringify(agents, null, 2));
    } else {
      if (agents.length === 0) {
        console.log('No agents found.');
        return;
      }

      // Table header
      const header = '  Name              Display Name      Org              Role                          Status          Last Heartbeat';
      const separator = '  ' + '-'.repeat(header.length - 2);
      console.log('\n  Agents\n');
      console.log(header);
      console.log(separator);

      for (const a of agents) {
        const name = pad(a.name, 18);
        const displayName = pad(a.display_name || '-', 18);
        const org = pad(a.org || '-', 17);
        const role = pad((a.role || '-').substring(0, 29), 30);
        // Show health indicator emoji
        const healthIcon = a.running ? '● ' : '○ ';
        const statusText = a.running ? 'running' : 'stopped';
        const status = (healthIcon + statusText).padEnd(16);
        const hb = a.last_heartbeat || '-';
        console.log(`  ${name}${displayName}${org}${role}${status}${hb}`);
      }

      console.log(`\n  Total: ${agents.length} agents\n`);
    }
  });
