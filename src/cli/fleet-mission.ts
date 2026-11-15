/** Read-only fleet briefing. Same document as GET /api/verse/fleet/runs/mission. */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { formatMission, readMissionControl, type MissionControlV1 } from '../core/fleet/mission-control.js';

const usage = 'Usage: ashlr fleet mission [--json] [--root <absolute-dir>]';

export async function cmdFleetMission(
  args: string[],
  read: (root: string) => Promise<MissionControlV1> = (root) => readMissionControl({ runsDir: root }),
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nOne briefing of the Mac fleet: whether it is moving, what merged this hour, and what needs a look. --json prints fleet.mission.v1, the same document as GET /api/verse/fleet/runs/mission. Missing files stay unknown. Reads <root> (default ~/.ashlr-runs) and never writes.`);
    return 0;
  }
  let json = false;
  let root = join(homedir(), '.ashlr-runs');
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || (arg !== '--json' && arg !== '--root')) {
      console.error(usage);
      return 2;
    }
    seen.add(arg);
    if (arg === '--json') json = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('-') || !isAbsolute(value) || value.includes('\0')) {
        console.error(usage);
        return 2;
      }
      root = value;
    }
  }
  let view: MissionControlV1;
  try { view = await read(root); }
  catch {
    console.error('fleet mission: unavailable');
    return 1;
  }
  console.log(json ? JSON.stringify(view) : formatMission(view));
  return 0;
}
