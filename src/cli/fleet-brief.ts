import { readLeaderBrief } from '../core/fleet/leader-brief.js';

const usage = 'Usage: ashlr fleet brief [--json]';

/** `ashlr fleet brief`: the Leader's read-only status brief (see core/fleet/leader-brief.ts). */
export async function cmdFleetBrief(args: string[], read: typeof readLeaderBrief = readLeaderBrief): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.some(arg => arg !== '--json')) { console.error(usage); return 2; }
  const brief = await read();
  console.log(args.includes('--json') ? JSON.stringify(brief) : brief.text);
  return 0;
}
