import { resolve } from 'node:path';
import { runPrConflictResolution, type ConflictRunOptions } from '../core/fleet/pr-conflict-run.js';
import { scrubSecrets } from '../core/util/scrub.js';
import { checkPrRecut, type PrRecutCheckDeps } from '../core/fleet/pr-recut-check.js';

const RECUT_USAGE = 'Usage: phm pr recut-check <n> [--repo owner/name] [--json]';
const USAGE = 'Usage: phm pr resolve-conflicts [--repo owner/name] [--pr N] [--limit N] [--root dir] [--out dir] [--allowlist file] [--apply] [--json]\n' + RECUT_USAGE;

export async function cmdPr(args: string[], deps: {
  run?: (options: ConflictRunOptions) => Promise<unknown>; stdout?: (text: string) => void;
  recut?: PrRecutCheckDeps;
} = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  if (args.includes('--help') || args.includes('-h')) { out(USAGE + '\n'); return 0; }
  if (args[0] === 'recut-check') {
    const pr = Number(args[1]);
    let repo = 'ashlrai/phantom';
    const seen = new Set<string>();
    let valid = /^\d+$/.test(args[1] ?? '') && Number.isSafeInteger(pr) && pr > 0;
    for (let i = 2; i < args.length; i++) {
      const flag = args[i]!;
      if (seen.has(flag)) valid = false;
      seen.add(flag);
      if (flag === '--json') continue;
      if (flag === '--repo' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(args[i + 1] ?? '')) repo = args[++i]!;
      else valid = false;
    }
    if (!valid) { out(RECUT_USAGE + '\n'); return 2; }
    const report = await checkPrRecut(pr, repo, deps.recut);
    const files = (paths: string[] | null) => paths === null ? 'unknown' : paths.join(', ') || 'none';
    const text = `${report.next}\nAlready on master: ${files(report.alreadyOnMasterFiles)}\nRemaining files: ${files(report.remainingFiles)}`;
    out(scrubSecrets(args.includes('--json') ? JSON.stringify(report) : text) + '\n');
    return report.alreadyOnMaster === null ? 1 : 0;
  }
  if (args[0] !== 'resolve-conflicts') { out(USAGE + '\n'); return 2; }
  const options: ConflictRunOptions = { apply: false, repo: 'ashlrai/phantom', limit: 500 };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) { out(USAGE + '\n'); return 2; }
    seen.add(flag);
    if (flag === '--json') continue;
    if (flag === '--apply') { options.apply = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) { out(USAGE + '\n'); return 2; }
    if (flag === '--repo' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) options.repo = value;
    else if (flag === '--root') options.root = resolve(value);
    else if (flag === '--out') options.outputDir = resolve(value);
    else if (flag === '--allowlist') options.allowlistFile = resolve(value);
    else if ((flag === '--pr' || flag === '--limit') && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) {
      if (flag === '--pr') options.pr = Number(value);
      else if (Number(value) <= 1000) options.limit = Number(value);
      else { out(USAGE + '\n'); return 2; }
    } else { out(USAGE + '\n'); return 2; }
  }
  try { out(scrubSecrets(JSON.stringify(await (deps.run ?? runPrConflictResolution)(options))) + '\n'); return 0; }
  catch { out(JSON.stringify({ schema: 'pr.resolve-conflicts.v1', dryRun: !options.apply,
    error: 'PR, hold-list or configuration evidence unavailable; no further PRs processed', prs: [] }) + '\n'); return 1; }
}
