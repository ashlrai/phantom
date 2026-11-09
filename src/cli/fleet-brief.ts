import { readLeaderBrief } from '../core/fleet/leader-brief.js';

export async function cmdFleetBrief(args: string[], read: typeof readLeaderBrief = readLeaderBrief): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log('Usage: ashlr fleet brief [--json]'); return 0; }
  if (args.some(arg => arg !== '--json')) { console.error('Usage: ashlr fleet brief [--json]'); return 2; }
  const brief = await read();
  console.log(args.includes('--json') ? JSON.stringify(brief) : brief.text);
  return 0;
}
