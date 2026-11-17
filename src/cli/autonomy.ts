import { readAutonomy } from '../core/fleet/autonomy.js';
const USAGE = 'Usage: phm autonomy [--hours 24] [--json]';
export async function cmdAutonomy(args: string[], options: Parameters<typeof readAutonomy>[0] = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  let hours = 24; let json = false; let seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours) { seenHours = true; hours = Number(args[++i]); }
    else { console.error(USAGE); return 2; }
  }
  if (!Number.isSafeInteger(hours) || hours <= 0 || hours > 720) { console.error(USAGE); return 2; }
  const r = await readAutonomy({ ...options, hours });
  console.log(json ? JSON.stringify(r) : `${r.headline}\nLast ${r.windowHours} hours: ${r.mergedPerHour === null ? 'unknown' : Math.round(r.mergedPerHour * 100) / 100} merged/hour; ${r.releases ?? 'unknown'} releases.\nMain green now: ${r.mainGreenShare === null ? 'unknown' : `${Math.round(r.mainGreenShare * 100)}%`}.`);
  return 0;
}
