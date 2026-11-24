import { armSweep, type ArmSweepOptions } from '../core/fleet/pr-arm-sweep.js';

const USAGE = 'Usage: phm prs arm-sweep [--repos phantom,locus] [--since 24h] [--apply] [--json]\nPreview auto-merge requests across seven AshlrAI repos. --apply arms them; superseded PRs are report-only. --since accepts minutes (m), hours (h) or days (d).';
export async function cmdPrsArmSweep(args: string[], deps: ArmSweepOptions & { output?: (text: string) => void; error?: (text: string) => void } = {}): Promise<number> {
  const out = deps.output ?? console.log, err = deps.error ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(USAGE); return 0; }
  const options: ArmSweepOptions = { gh: deps.gh, now: deps.now };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) { err(USAGE); return 2; }
    seen.add(flag);
    if (flag === '--json') continue;
    if (flag === '--apply') { options.apply = true; continue; }
    const value = args[++i] ?? '';
    if (flag === '--repos' && value.split(',').every(r => /^(?:ashlrai\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(r))) options.repos = value.split(',');
    else if (flag === '--since' && /^[1-9]\d*[mhd]$/.test(value)) options.sinceMs = Number(value.slice(0, -1)) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[value.slice(-1)] ?? 0);
    else { err(USAGE); return 2; }
  }
  if (options.sinceMs !== undefined && !Number.isSafeInteger(options.sinceMs)) { err(USAGE); return 2; }
  const report = await armSweep(options);
  if (seen.has('--json')) out(JSON.stringify(report));
  else {
    for (const row of report.rows) out(`${row.repo} #${row.number} ${row.title}: ${row.action}${row.reason ? ` — ${row.reason}` : ''}`);
    for (const row of report.closeCandidates) out(`${row.repo} #${row.number} ${row.title}: close candidate — superseded by #${row.supersededBy} (report only)`);
    for (const error of report.errors) out(`${error.repo}: ${error.reason}`);
    out(`Armed ${report.counts.armed}; would arm ${report.counts.wouldArm}; skipped ${report.rows.filter(r => r.action === 'skipped').length}; repo errors ${report.errors.length}.`);
  }
  return report.errors.length || report.rows.some(r => r.reason === 'Auto-merge request failed') ? 1 : 0;
}
