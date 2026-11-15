import { readReleaseLag, releaseLagLine, type ReleaseLagSources } from '../core/release/lag.js';

const USAGE = 'Usage: ashlr fleet release-lag [--json]\n'
  + 'Read-only report of the gap between the latest published Phantom release and this machine\'s installed app. '
  + 'Prints phantom.release-lag/v1 JSON with --json, else one human line. Fields that cannot be read stay "unknown". '
  + 'Performs reads only: no publication, tagging, installs or notifications.';

export async function cmdFleetReleaseLag(args: string[], sources?: ReleaseLagSources): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  if (args.some(arg => arg !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const lag = await readReleaseLag(sources);
  process.stdout.write(json ? `${JSON.stringify(lag)}\n` : `${releaseLagLine(lag)}\n`);
  return 0;
}
