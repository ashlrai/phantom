import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { laneScoresPath, readLaneScores, type LaneScoreRow } from '../eval/passk.js';

export interface RouterOutcome {
  schema: 'router.outcome.v1'; job_id: string; lane: string | null; model: string | null;
  tier: string | null; work_class: string | null; merged: boolean | null; ci_first_pass: boolean | null;
  review_findings: { fixed: number; rejected: number; ignored: number } | null;
  cost_usd: number | null; wall_s: number | null; passk: LaneScoreRow | null;
}

export async function readBoundedRouterFile(path: string, limit = 1024 * 1024): Promise<string | null> {
  try {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > limit) return null;
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
      return bytesRead > limit ? null : bytes.subarray(0, bytesRead).toString('utf8');
    } finally { await fd.close(); }
  } catch { return null; }
}

type Row = Record<string, unknown>;
const record = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const str = (r: Row, ...keys: string[]): string | null => {
  for (const k of keys) if (typeof r[k] === 'string' && r[k].trim()) return r[k].trim();
  return null;
};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

export function foldRouterOutcomes(text: string, scores: readonly LaneScoreRow[] = []): RouterOutcome[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    try { rows.push(record(JSON.parse(line))); } catch { /* malformed ledger row */ }
  }
  const id = (r: Row) => str(r, 'job', 'job_id', 'jobId', 'id');
  const url = (r: Row) => str(r, 'url', 'pr_url', 'prUrl', 'pr');
  const byUrl = new Map<string, string>();
  for (const r of rows) { const j = id(r), u = url(r); if (j && u) byUrl.set(u, j); }
  const jobs = new Map<string, RouterOutcome>();
  const outcomeTimes = new Map<string, number>();
  for (const r of rows) {
    const j = id(r) ?? byUrl.get(url(r) ?? '');
    if (!j) continue;
    const o = jobs.get(j) ?? { schema: 'router.outcome.v1', job_id: j, lane: null, model: null,
      tier: null, work_class: null, merged: null, ci_first_pass: null, review_findings: null,
      cost_usd: null, wall_s: null, passk: null };
    o.lane = str(r, 'lane', 'pool', 'arm') ?? o.lane;
    o.model = str(r, 'model') ?? o.model;
    o.tier = str(r, 'tier') ?? o.tier;
    o.work_class = str(r, 'work_class') ?? o.work_class;
    const phase = (str(r, 'phase', 'state', 'outcome', 'status') ?? '').toUpperCase();
    const merged = phase === 'MERGED' ? true : phase === 'CLOSED' ? false : typeof r['merged'] === 'boolean' ? r['merged'] : null;
    if (merged !== null) {
      const ts = Date.parse(str(r, 'ts', 'timestamp', 'at', 'mergedAt', 'closedAt') ?? '') || 0;
      if (ts >= (outcomeTimes.get(j) ?? -1)) { o.merged = merged; outcomeTimes.set(j, ts); }
    }
    if (typeof r['ci_first_pass'] === 'boolean') o.ci_first_pass = r['ci_first_pass'];
    o.cost_usd = num(r['cost_usd']) ?? o.cost_usd;
    o.wall_s = num(r['wall_s']) ?? o.wall_s;
    const f = record(r['review_findings']);
    if (['fixed', 'rejected', 'ignored'].every(k => Number.isSafeInteger(f[k]) && (f[k] as number) >= 0)) {
      o.review_findings = { fixed: f['fixed'] as number, rejected: f['rejected'] as number, ignored: f['ignored'] as number };
    }
    jobs.set(j, o);
  }
  return [...jobs.values()].map(o => ({ ...o, passk: scores.find(s => s.lane === o.lane && s.model === o.model) ?? null }));
}

export async function readRouterOutcomes(opts: { runsDir?: string; rootDir?: string; lane?: string } = {}): Promise<RouterOutcome[]> {
  const [text, scoreText] = await Promise.all([
    readBoundedRouterFile(join(opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'metrics/jobs.jsonl'), 16 * 1024 * 1024),
    readBoundedRouterFile(laneScoresPath(opts), 256 * 1024),
  ]);
  const scores = readLaneScores({ ...opts, readFile: () => scoreText ?? '' }).scores?.lanes ?? [];
  return foldRouterOutcomes(text ?? '', scores).filter(o => opts.lane === undefined || o.lane === opts.lane);
}
