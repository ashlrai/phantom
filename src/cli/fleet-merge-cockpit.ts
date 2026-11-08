/** Read-only merge cockpit: the rebase treadmill from local runs state only. */
import { isAbsolute } from 'node:path';
import { readMergeCockpit, type MergeCockpitReport, type MergeCockpitRepo } from '../core/fleet/merge-cockpit.js';

const usage = 'Usage: phm fleet merge-cockpit [--root <abs>] [--hours <n>] [--json]';
const MAX_HOURS = 24 * 30;

const fmtSecs = (v: number | null): string => v === null ? 'unknown' : `${v}s`;

function latencyCell(l: { medianS: number | null; p90S: number | null; count: number } | null): string {
  if (!l || l.count === 0) return 'n/a';
  return `${fmtSecs(l.medianS)}/${fmtSecs(l.p90S)} (${l.count})`;
}

function coverageCell(r: MergeCockpitRepo): string {
  if (r.coverage === null) return 'queue unknown';
  const c = r.coverage;
  if (r.conflictsOpen === 0) return 'none open';
  return `${c.current} current, ${c.staleHead} stale-head, ${c.worked} worked, ${c.uncovered} uncovered`;
}

function repoLine(r: MergeCockpitRepo): string {
  const mergeRate = `${r.merges.count} merged, ${r.merges.perHour.toFixed(2)}/h, median ttm ${fmtSecs(r.merges.medianTtmS)}`;
  const rebase = `rebase ready ${r.rebase.ready} running ${r.rebase.running} parked ${r.rebase.parked} spins ${r.rebase.spins} runs ${r.rebase.runs} repeat-prs ${r.rebase.repeatPrs}`;
  return `${r.repo}: ${r.conflictsOpen} conflicting open (${r.conflictsTriaged} triaged, ${r.conflictsClosed} closed${r.conflictsUntracked ? `, ${r.conflictsUntracked} untracked` : ''})`
    + `\n  coverage: ${coverageCell(r)} | triage→close ${latencyCell(r.triageToCloseS)}`
    + `\n  ${rebase}\n  ${mergeRate}`;
}

export function formatMergeCockpit(report: MergeCockpitReport): string {
  if (!report.known) return 'Merge cockpit: unknown (no runs state readable under the root)';
  const t = report.totals;
  const lines = [
    `Merge cockpit (last ${report.hours}h${report.jobsClipped ? ', jobs ledger clipped' : ''}):`,
    ...report.repos.map(repoLine),
    `total: ${t.conflictsOpen} conflicting open, ${t.conflictsTriaged} triaged, ${t.conflictsClosed} closed;`
      + ` triage→close ${latencyCell(t.triageToCloseS)}; rebase ${t.rebase.ready} ready/${t.rebase.running} running/${t.rebase.parked} parked, ${t.rebase.spins} spins, ${t.rebase.runs} runs, ${t.rebase.repeatPrs} repeat prs;`
      + ` ${t.merges.count} merged, ${t.merges.perHour.toFixed(2)}/h, median ttm ${fmtSecs(t.merges.medianTtmS)}`,
    `sources: ${Object.entries(report.sources).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  ];
  if (report.repos.length === 0) lines.splice(1, 0, '  (no repos with rebase or merge evidence in window)');
  return lines.join('\n');
}

export async function cmdFleetMergeCockpit(
  args: string[],
  deps: { runsDir?: string; now?: number; read?: typeof readMergeCockpit } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log([
      usage,
      'The rebase treadmill from local ~/.ashlr-runs state only: no gh, no git, no network.',
      'Per repo: conflicting bridge PRs open on the treadmill, rebase-job coverage of the latest emitted head,',
      'triage-to-close latency (median/p90 seconds) and merge rate (count, per hour, median ttm).',
      'Sources: queue/*.queuegen-state.json triage records, queue/ready.tsv + claimed.tsv live jobs,',
      'metrics/jobs.jsonl outcomes and rebase runs, queue/landed-closes.jsonl and metrics/merge-events.jsonl closes.',
      '--root selects another runs directory (ASHLR_RUNS_DIR honoured); --hours bounds the window (default 24, max 720).',
      'Each source reports its own health; coverage is null when the queue is unreadable. Exit is always 0.',
    ].join('\n'));
    return 0;
  }
  let root = deps.runsDir;
  let hours: number | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--root' && isAbsolute(args[i + 1] ?? '')) root = args[++i]!;
    else if (arg === '--hours' && /^[1-9]\d{0,3}$/.test(args[i + 1] ?? '') && Number(args[i + 1]) <= MAX_HOURS) hours = Number(args[++i]);
    else { console.error(`error: invalid fleet merge-cockpit arguments\n${usage}`); return 2; }
  }
  const report = await (deps.read ?? readMergeCockpit)({ runsDir: root, hours, now: deps.now });
  console.log(json ? JSON.stringify(report) : formatMergeCockpit(report));
  return 0;
}
