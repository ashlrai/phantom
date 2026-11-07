/** `ashlr fleet lane-model-drift` — RQ-PHX-LANEMODELDRIFT18: which lane models
 * in <runsDir>/models.json the Phantom catalog does not know — a typo, a
 * retired id, or a release it has not caught up with. Read-only; never writes.
 * Exits 1 when any resolved model is unknown so the planner can act on it. */
import { isAbsolute } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { makeColors, isTty, pad } from './ui.js';
import { getLaneModelSnapshot } from '../core/fleet/lane-models.js';
import { laneModelDrift, type LaneModelDriftReport } from '../core/fleet/lane-model-drift.js';
import { KNOWN_MODELS } from '../core/run/model-catalog.js';

const { red } = makeColors(isTty());
const USAGE = 'usage: ashlr fleet lane-model-drift [--all] [--json] [--runs-dir <abs>] [--models <abs>]';

/** Pure, no-color render — unit-testable without I/O. */
export function formatLaneModelDrift(report: LaneModelDriftReport, all = false): string {
  const rows = all ? report.rows : report.rows.filter(r => r.status !== 'known');
  const LT = Math.max(0, ...rows.map(r => r.lane.length + r.tier.length + 1));
  const M = Math.max(0, ...rows.map(r => r.model.length));
  const lines = rows.map(r =>
    `${pad(`${r.lane}.${r.tier}`, LT)}  ${pad(r.model, M)}  ${r.status}  via ${r.via}`);
  const c = report.counts;
  lines.push(`total: ${report.rows.length} resolved — ${c.known} known, ${c.historical} historical, ${c.unknown} unknown`);
  const m = report.sources.models, j = report.sources.launches;
  lines.push(`sources: models.json ${m.state}${m.state === 'missing' ? '' : ` (${m.entries} entries)`}` +
    ` · jobs.jsonl ${j.state}${j.state === 'missing' ? '' : ` (${j.launches} launches${j.dropped ? `, ${j.dropped} dropped` : ''})`}`);
  return lines.join('\n');
}

export async function cmdFleetLaneModelDrift(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const bad = rejectUnknownOptions(args, { flags: ['--all', '--json'], values: ['--runs-dir', '--models'] });
  if (bad) {
    process.stderr.write(red('error: ') + `fleet lane-model-drift: ${bad.message}\n${USAGE}\n`);
    return 2;
  }
  const opts: { runsDir?: string; modelsPath?: string } = {};
  for (const [flag, key] of [['--runs-dir', 'runsDir'], ['--models', 'modelsPath']] as const) {
    const at = args.indexOf(flag);
    if (at < 0) continue;
    const value = args[at + 1];
    if (!value || !isAbsolute(value)) {
      process.stderr.write(red('error: ') + `fleet lane-model-drift: ${flag} requires an absolute path\n`);
      return 2;
    }
    opts[key] = value;
  }
  const report = laneModelDrift(await getLaneModelSnapshot(opts), KNOWN_MODELS);
  console.log(args.includes('--json') ? JSON.stringify(report) : formatLaneModelDrift(report, args.includes('--all')));
  return report.counts.unknown > 0 ? 1 : 0;
}
