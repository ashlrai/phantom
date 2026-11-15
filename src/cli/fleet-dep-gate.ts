import { isAbsolute } from 'node:path';
import { readDepGate } from '../core/fleet/dep-gate.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet dep-gate [--json] [--runs-dir <abs>]';

export async function cmdFleetDepGate(
  args: string[], deps: { read?: typeof readDepGate; now?: () => number } = {},
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
  const report = await (deps.read ?? readDepGate)({ runsDir, now: deps.now });
  if (json) console.log(JSON.stringify(sanitizePublicJson(report)));
  else {
    const safeText = (text: string): string => String(sanitizePublicJson(scrubSecrets(text)))
      // eslint-disable-next-line no-control-regex -- terminal output must not contain control characters.
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
    const sources = Object.entries(report.sources).map(([name, state]) => `${name}=${state}`).join(' ');
    const lines = [`dep-gate: ${sources}; ${report.rows} rows, ${report.gated} gated`];
    for (const row of report.unmet) {
      lines.push(`UNMET-DEP ${safeText(row.job)} (${safeText(row.lane ?? 'unknown')}): ${row.unmet.join(', ')}`);
    }
    if (report.unmet.length === 0) lines.push('dep-gate: clear');
    console.log(lines.join('\n'));
  }
  return report.unmet.length > 0 || Object.values(report.sources).includes('degraded') ? 1 : 0;
}
