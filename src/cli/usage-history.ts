import { isAbsolute } from 'node:path';
import { defaultResourceLiveRunsDir } from '../core/usage/resource-live/feed.js';
import { readLaneHistory } from '../core/usage/resource-live/history.js';

const USAGE = 'Usage: phm usage history --lane <id> [--json] [--runs-dir <abs>]';
export async function cmdUsageHistory(args: string[]): Promise<number> {
  let lane = '', runsDir = defaultResourceLiveRunsDir(), json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json') json = true;
    else if (arg === '--lane') lane = args[++i] ?? '';
    else if (arg === '--runs-dir') runsDir = args[++i] ?? '';
    else { console.error(USAGE); return 2; }
  }
  if (!lane || !isAbsolute(runsDir) || /(?:^|\/)\.codex[^/]*(?:\/|$)/.test(runsDir)) { console.error(USAGE); return 2; }
  const result = await readLaneHistory(lane, runsDir);
  if (!result) { console.error(USAGE); return 2; }
  if (json) console.log(JSON.stringify(result));
  else for (const p of result.points) console.log(`${p.observed_at} used=${p.used}/${p.limit} left=${p.left ?? 'unknown'} ${p.unit ?? ''} source=${p.source} confidence=${p.confidence ?? 'unknown'}`);
  return 0;
}
