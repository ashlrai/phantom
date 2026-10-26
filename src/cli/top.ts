import { collectTopSnapshot } from '../core/fleet/top.js';

const USAGE = 'Usage: phm top --json [--fleet <path>]';

export async function cmdTop(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  let json = false;
  let fleetPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--fleet' && fleetPath === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) fleetPath = args[++i];
    else {
      console.error(USAGE);
      return 2;
    }
  }
  if (!json) {
    console.error(USAGE);
    return 2;
  }
  try {
    const snapshot = collectTopSnapshot({ fleetPath });
    console.log(JSON.stringify(snapshot));
    return snapshot.sources.fleet === 'ready' ? 0 : 1;
  } catch {
    // Never print source payloads, exception text, file paths or provider errors.
    console.error('Top snapshot unavailable.');
    return 1;
  }
}
