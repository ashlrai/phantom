/** `ashlr fleet lane-models` — RQ-PHX-LANEMODELVIEW31: the effective model per
 * lane and tier from <runsDir>/models.json, cross-checked against the newest
 * launch row per lane in metrics/jobs.jsonl. Read-only; never writes. */
import { isAbsolute } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { makeColors, isTty } from './ui.js';
import { getLaneModelSnapshot, type LaneModelSnapshot } from '../core/fleet/lane-models.js';

const { red } = makeColors(isTty());
const USAGE = 'usage: ashlr fleet lane-models [--json] [--runs-dir <abs>] [--models <abs>]';

const pad = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
const ago = (iso: string | null, nowMs: number): string => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const m = Math.floor(Math.max(0, nowMs - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

/** Pure, no-color render — unit-testable without I/O. */
export function formatLaneModels(snapshot: LaneModelSnapshot, nowMs = Date.now()): string {
  const lines = [`Lane models — ${snapshot.schema} · generated ${ago(snapshot.generatedAt, nowMs) || snapshot.generatedAt}`, ''];
  const L = Math.max(4, ...snapshot.lanes.map(l => l.lane.length)), T = Math.max(4, ...snapshot.tiers.map(t => t.length));
  const M = Math.max(5, ...snapshot.lanes.flatMap(l => l.tiers.map(r => r.model?.length ?? 0)));
  const V = Math.max(3, ...snapshot.lanes.flatMap(l => l.tiers.map(r => r.via?.length ?? 0)));
  lines.push(`  ${pad('lane', L)} ${pad('tier', T)} ${pad('model', M)} ${pad('via', V)} last launch`);
  lines.push(`  ${'─'.repeat(L + T + M + V + 15)}`);
  if (snapshot.lanes.length === 0) lines.push('  (no lanes — models.json and jobs.jsonl are missing or empty)');
  for (const lane of snapshot.lanes) {
    const last = lane.lastLaunch
      ? `${lane.lastLaunch.model}${lane.lastLaunch.tier ? ` (${lane.lastLaunch.tier})` : ''} ${ago(lane.lastLaunch.at, nowMs)}`.trim()
      : '—';
    const flag = !lane.lastLaunch ? '—' : lane.mismatch ? 'MISMATCH' : 'match';
    lane.tiers.forEach((row, i) => lines.push(
      `  ${pad(i === 0 ? lane.lane : '', L)} ${pad(row.tier, T)} ${pad(row.model ?? '—', M)} ${pad(row.via ?? '—', V)} ${i === 0 ? `${last} ${flag}` : ''}`));
  }
  const m = snapshot.sources.models, j = snapshot.sources.launches;
  lines.push('', `  sources: models.json ${m.state}${m.state === 'missing' ? '' : ` (${m.entries} entries)`}` +
    ` · jobs.jsonl ${j.state}${j.state === 'missing' ? '' : ` (${j.launches} launches${j.dropped ? `, ${j.dropped} dropped` : ''})`}`);
  if (snapshot.lanes.some(l => l.mismatch)) lines.push('  MISMATCH: a lane\'s newest launch ran another model than the map assigns — stale worker or unproved change.');
  return lines.join('\n');
}

export async function cmdFleetLaneModels(args: string[]): Promise<number> {
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: ['--runs-dir', '--models'] });
  if (bad) {
    process.stderr.write(red('error: ') + `fleet lane-models: ${bad.message}\n${USAGE}\n`);
    return 2;
  }
  const opts: { runsDir?: string; modelsPath?: string } = {};
  for (const [flag, key] of [['--runs-dir', 'runsDir'], ['--models', 'modelsPath']] as const) {
    const at = args.indexOf(flag);
    if (at < 0) continue;
    const value = args[at + 1];
    if (!value || !isAbsolute(value)) {
      process.stderr.write(red('error: ') + `fleet lane-models: ${flag} requires an absolute path\n`);
      return 2;
    }
    opts[key] = value;
  }
  const snapshot = await getLaneModelSnapshot(opts);
  console.log(args.includes('--json') ? JSON.stringify(snapshot) : formatLaneModels(snapshot));
  return 0;
}
