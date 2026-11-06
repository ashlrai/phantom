import { isAbsolute } from 'node:path';
import { readReadySupply } from '../core/fleet/ready-supply.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet ready-supply [--json] [--runs-dir <abs>]';

export async function cmdFleetReadySupply(
  args: string[], deps: { read?: typeof readReadySupply; now?: () => Date } = {},
): Promise<number> {
  let json = false;
  let help = false;
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--help' || arg === '-h') && !help) help = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (!value || !isAbsolute(value)) { console.error(usage); return 2; }
      runsDir = value;
    } else { console.error(usage); return 2; }
  }
  if (help) { console.log(usage); return 0; }
  const result = await (deps.read ?? readReadySupply)({ runsDir, now: deps.now });
  if (json) console.log(JSON.stringify(sanitizePublicJson(result)));
  else {
    const safeText = (text: string): string => String(sanitizePublicJson(text))
      // eslint-disable-next-line no-control-regex -- terminal output must not contain control characters.
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
    const lines = result.lanes.map(lane =>
      `${safeText(lane.lane)}  phantom ${lane.phxReady} ready${lane.oldestPhxId === null ? '' : ` (next ${safeText(lane.oldestPhxId)})`}, ${lane.phxParked} parked; filler ${lane.fillerReady} ready, ${lane.fillerParked} parked`);
    const total = result.totals;
    lines.push(`total  phantom ${total.phxReady} ready, ${total.phxParked} parked; filler ${total.fillerReady} ready, ${total.fillerParked} parked`);
    lines.push(`source: ${result.sourceState}`);
    console.log(lines.join('\n'));
  }
  return result.sourceState === 'degraded' ? 1 : 0;
}
