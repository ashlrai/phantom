/** `ashlr fleet apps-events` — read normalized apps-watch bus events. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAppsEvents } from '../core/fleet/apps-events.js';

const usage = 'Usage: ashlr fleet apps-events [--json] [--after <N>] [--limit <1..100>] [--root <dir>] [--invocation <id>]';

export async function cmdFleetAppsEvents(args: string[], opts: { runsDir?: string; now?: () => number } = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  let json = false;
  let after = 0;
  let limit = 50;
  let root: string | undefined;
  let invocation: string | undefined;
  let hasAfter = false, hasLimit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) { json = true; }
    else if (arg === '--after' && !hasAfter && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      const val = Number(args[++i]);
      if (!Number.isSafeInteger(val) || val < 0) { console.error(usage); return 2; }
      after = val; hasAfter = true;
    }
    else if (arg === '--limit' && !hasLimit && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      const val = Number(args[++i]);
      if (!Number.isSafeInteger(val) || val < 1 || val > 100) { console.error(usage); return 2; }
      limit = val; hasLimit = true;
    }
    else if (arg === '--root' && root === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      root = args[++i];
    }
    else if (arg === '--invocation' && invocation === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      invocation = args[++i];
    }
    else { console.error(usage); return 2; }
  }
  try {
    const resolvedRoot = root ?? opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    const result = readAppsEvents(after, limit, {
      root: resolvedRoot,
      invocationId: invocation,
      now: opts.now,
    });
    console.log(JSON.stringify(result, null, json ? undefined : 2));
    return result.status === 'invalid' ? 2 : result.status === 'unavailable' ? 1 : 0;
  } catch {
    console.error('Unable to read apps events.');
    return 1;
  }
}
