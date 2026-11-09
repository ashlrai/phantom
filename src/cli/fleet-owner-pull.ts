/** Pull configured remote owner channels into the shared thread. */
import { rejectUnknownOptions } from './args.js';
import { ownerThreadOptions } from './comms-owner-thread.js';
import { pullOwnerChannel, readOwnerCommsStatus, type OwnerThreadOptions } from '../core/comms/owner-thread.js';

const channels = ['telegram', 'slack', 'email', 'imessage'] as const;
type RemoteChannel = typeof channels[number];
const usage = 'Usage: ashlr fleet owner-pull [--channel telegram|slack|email|imessage] [--json]';

export interface FleetOwnerPullDeps {
  options?: OwnerThreadOptions;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdFleetOwnerPull(args: string[], deps: FleetOwnerPullDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: ['--channel'] });
  const selected = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined;
  const validArgs = args.every((arg, i) => arg === '--json' || arg === '--channel' || (i > 0 && args[i - 1] === '--channel'));
  if (bad || !validArgs || (args.includes('--channel') && !channels.includes(selected as RemoteChannel)) ||
      args.filter(arg => arg === '--channel').length > 1 || args.filter(arg => arg === '--json').length > 1) {
    error(bad?.message ?? usage);
    return 2;
  }
  const options = deps.options ?? ownerThreadOptions();
  const status = readOwnerCommsStatus(options);
  let halted = status.kill || status.paused;
  const rows: Array<{ channel: RemoteChannel; pulled: boolean; accepted: number; duplicate: number; refused: number; unavailable: number; reason?: string; nextStep?: string }> = [];
  if (!halted) {
    for (const channel of channels) {
      if (selected && selected !== channel) continue;
      const adapter = status.adapters.find(item => item.id === channel)!;
      const row: typeof rows[number] = { channel, pulled: false, accepted: 0, duplicate: 0, refused: 0, unavailable: 0 };
      if (!adapter.configured || !adapter.enabled) {
        row.reason = adapter.reason;
        if (adapter.nextStep) row.nextStep = adapter.nextStep;
      } else {
        row.pulled = true;
        const results = await pullOwnerChannel(channel, options);
        for (const result of results) {
          if (result.status === 'accepted' || result.status === 'duplicate' || result.status === 'refused' || result.status === 'unavailable') row[result.status]++;
          if (result.status === 'halted') halted = true;
        }
      }
      rows.push(row);
      if (halted) break;
    }
  }
  if (args.includes('--json')) output(JSON.stringify({ schema: 'fleet.owner-pull.v1', halted, channels: rows }));
  else {
    if (halted) output('halted');
    for (const row of rows) output(row.pulled ? `${row.channel}: ${row.accepted}/${row.duplicate}/${row.refused} new/dup/refused` : `${row.channel}: skipped (${row.reason})${row.nextStep ? ` next: ${row.nextStep}` : ''}`);
  }
  return rows.some(row => row.unavailable > 0) ? 1 : 0;
}
