import { cmdFleetMapMessages } from './fleet-map-messages.js';

/** The map's existing reader, with the fleet messages row contract. */
const usage = 'Usage: phm fleet messages [--since <ts>] [--json]';
export async function cmdFleetMessages(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  return cmdFleetMapMessages(args, true);
}
