/** `ashlr fleet red-fix` — drop one fix job per red fleet bridge PR (dry run by default). */
import { isAbsolute } from 'node:path';
import { assertRepo, type Gh } from '../core/autopilot/github.js';
import { runRedPrFix, type RedPrFixReportV1 } from '../core/fleet/red-pr-fix-job.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: ashlr fleet red-fix [--json] [--hours <n>] [--write] [--runs-dir <abs>] [--repo <owner/name>]';

export interface FleetRedFixDeps {
  gh?: Gh;
  now?: () => number;
  run?: (opts: { repo: string; hours: number; write: boolean; runsDir?: string; gh?: Gh; now?: () => number }) => Promise<RedPrFixReportV1>;
}

export async function cmdFleetRedFix(args: string[], deps: FleetRedFixDeps = {}): Promise<number> {
  let json = false;
  let write = false;
  let help = false;
  let hoursArg: string | undefined;
  let runsDir: string | undefined;
  let repoArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--help' || arg === '-h') && !help) { help = true; continue; }
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--write' && !write) { write = true; continue; }
    if ((arg === '--hours' && hoursArg === undefined)
      || (arg === '--runs-dir' && runsDir === undefined)
      || (arg === '--repo' && repoArg === undefined)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || value.includes('\0')) {
        console.error(USAGE);
        return 2;
      }
      if (arg === '--hours') hoursArg = value;
      else if (arg === '--runs-dir') runsDir = value;
      else repoArg = value;
      continue;
    }
    console.error(USAGE);
    return 2;
  }
  if (help) { console.log(USAGE); return 0; }
  const hours = hoursArg === undefined ? 24 : Number(hoursArg);
  const repo = repoArg ?? 'ashlrai/phantom';
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168
    || (runsDir !== undefined && !isAbsolute(runsDir))) {
    console.error(USAGE);
    return 2;
  }
  try {
    assertRepo(repo);
  } catch {
    console.error(USAGE);
    return 2;
  }
  let report: RedPrFixReportV1;
  try {
    report = await (deps.run ?? runRedPrFix)({ repo, hours, write, runsDir, gh: deps.gh, now: deps.now });
  } catch {
    console.error('fleet red-fix: report unavailable');
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(sanitizePublicJson(report)));
  } else {
    for (const c of report.candidates) {
      const status = c.written ? 'written' : c.skipped !== null ? `skipped: ${c.skipped}` : 'dry-run';
      console.log(`#${c.number} ${c.jobId} code-failure -> RQ-PHX-${c.fixId} (${status})`);
    }
    if (report.candidates.length === 0) console.log('no red fleet PRs');
    if (report.reason !== null) console.error(`fleet red-fix: ${report.reason}`);
  }
  return 0;
}
