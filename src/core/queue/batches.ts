import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { scrubPrivateText } from '../util/scrub.js';
import { fitRoute, type RouteSkipCode } from '../fleet/lane-capabilities.js';
import { supersedeQueue } from './supersede.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).refine(value => scrubPrivateText(value) === value);
const status = z.enum(['done', 'skipped', 'failed', 'deferred', 'unreported', 'released']);
const manifestSchema = z.object({
  schema: z.literal('dispatchd.batch.v1'), id, repo: id, area: z.string().max(200),
  created_at: z.number().finite().positive(), mode: z.literal('per-line'),
  members: z.array(z.object({ job: id })).min(1).max(10)
    .refine(members => new Set(members.map(m => m.job)).size === members.length),
  outcomes: z.record(z.string(), status).optional(), handled: z.record(z.string(), status).optional(),
  results: z.record(z.string(), z.object({ outcome: status, reason: z.string().max(500).nullable() })).optional(),
});
type Manifest = z.infer<typeof manifestSchema>;
const rankingSchema = z.object({ at: z.number().finite().positive(), decisions: z.array(z.object({
  job: id, mergeRate: z.number().min(0).max(1).nullable(), sampledLaunches: z.number().int().nonnegative(),
  unknownLaunches: z.number().int().nonnegative(), score: z.number().min(0.1).max(1),
  reason: z.enum(['observed_merge_rate_24h', 'unknown_sample', 'unknown_outcomes', 'target_pr_merged', 'target_pr_closed', 'already-merged']),
  outcome: z.enum(['ready', 'DONE-NOOP']),
})).max(10000) });
export interface BatchLineOutcome {
  job: string; outcome: 'pr' | 'empty' | 'failed' | 'unknown';
  pr: string | null; reason: string | null; autoMerge: 'armed' | 'off' | 'unknown';
}
export interface EmptyPrefixReport {
  windowHours: 24; evidence: 'available' | 'partial' | 'unknown';
  total: number | null; malformedLines: number | null;
  top: Array<{ prefix: string; count: number }>;
}
/** Ready jobs whose lane is declared unable to do them. A forecast from queue files; nothing is moved. */
export interface RouteSkipReport {
  evidence: 'available' | 'partial' | 'unknown';
  /** Ready rows whose prompt was read; null when ready.tsv is unreadable. */
  checked: number | null;
  /** Rows kept on their lane because a gh context pack is attached. */
  packed: number | null;
  skips: Array<{ job: string; lane: string; code: RouteSkipCode; packWouldFix: boolean; line: string }>;
}
export interface QueueBatchReport {
  schema: 'phantom.queue-batches.v1'; evidence: 'available' | 'partial' | 'unknown';
  sessions: Array<{ id: string; repo: string; area: string; outcomes: BatchLineOutcome[] }>;
  totals: { sessions: number; lines: number; pr: number; empty: number; failed: number; unknown: number } | null;
  gaps: string[];
  ranking: z.infer<typeof rankingSchema> | null;
  emptyPrefixes: EmptyPrefixReport;
  routeSkips: RouteSkipReport;
  /** Queued jobs a newer cycle of the same job replaces (`phm queue supersede`); null when the queue is unreadable. */
  superseded: number | null;
}

/** Bound each read and refuse symlinks/devices; receipts are evidence, never executable input. */
async function snapshot(path: string, cap: number): Promise<{ text: string; modified: number }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > cap) throw new Error('Invalid evidence file');
    const bytes = Buffer.alloc(cap + 1);
    let size = 0;
    while (size <= cap) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > cap) throw new Error('Evidence exceeds read limit');
    return { text: bytes.subarray(0, size).toString('utf8'), modified: stat.mtimeMs };
  } finally { await file.close(); }
}

/** Count finish rows, not job identities: retries consume separate launches. */
async function readEmptyPrefixes(root: string, now: number): Promise<EmptyPrefixReport> {
  const report: EmptyPrefixReport = { windowHours: 24, evidence: 'unknown', total: null, malformedLines: null, top: [] };
  let text: string;
  try { text = (await snapshot(join(root, 'metrics', 'jobs.jsonl'), 16 * 1024 * 1024)).text; }
  catch { return report; }
  const groups = new Map<string, number>();
  report.total = 0; report.malformedLines = 0; report.evidence = 'available';
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
      // jobs.jsonl event names arrive as event|type|kind; stamps as
      // ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt.
      if ((row.event ?? row.type ?? row.kind) !== 'finish') continue;
      const job = id.parse(row.job ?? row.job_id ?? row.jobId ?? row.id);
      const stamp = row.ts ?? row.timestamp ?? row.at ?? row.time ?? row.mergedAt ?? row.closedAt ?? row.recordedAt ?? row.updatedAt;
      const at = typeof stamp === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp) ? Date.parse(stamp) : NaN;
      if (!Number.isFinite(at)) throw new Error();
      if (at < now - 86400000 || at > now) continue;
      if (typeof row.empty !== 'boolean') throw new Error();
      if (!row.empty) continue;
      // Strip generated filler counters / incident hashes; retain lane and task family.
      const prefix = job.replace(/A\d{6,}Q8$/, 'A').replace(/-(?:[a-f0-9]{8,}|\d+)(?:-\d+)?$/i, '');
      groups.set(prefix, (groups.get(prefix) ?? 0) + 1); report.total++;
    } catch { report.malformedLines++; report.evidence = 'partial'; }
  }
  report.top = [...groups].map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix)).slice(0, 5);
  return report;
}

/** ready.tsv rows are job, repo, lane, tier, prompt path. Prompts are read only from queue/prompts. */
async function readRouteSkips(root: string): Promise<RouteSkipReport> {
  const report: RouteSkipReport = { evidence: 'unknown', checked: null, packed: null, skips: [] };
  let rows: string[];
  try { rows = (await snapshot(join(root, 'queue', 'ready.tsv'), 4 * 1024 * 1024)).text.split(/\r?\n/).filter(Boolean); }
  catch { return report; }
  report.evidence = rows.length > 1000 ? 'partial' : 'available'; report.checked = 0; report.packed = 0;
  for (const row of rows.slice(0, 1000)) {
    const [job, , lane, , prompt] = row.split('\t');
    if (job?.startsWith('PARKED-')) continue;
    try {
      const fit = fitRoute({ job: id.parse(job), lane: id.parse(lane),
        prompt: (await snapshot(join(root, 'queue', 'prompts', basename(prompt ?? '')), 1024 * 1024)).text });
      report.checked++;
      if (fit.decision === 'route_with_pack') report.packed++;
      // The forecast knows no candidate lanes, so it says where the job sits, not where it goes.
      if (fit.code) report.skips.push({ job: fit.job!, lane: fit.lane, code: fit.code, packWouldFix: fit.pack_would_fix,
        line: `${fit.job} is queued on ${fit.lane}, which cannot use ${fit.code.slice('route_skip: lane lacks '.length)}.${fit.pack_would_fix ? ' A gh context pack would let it stay.' : ''}` });
    } catch { report.evidence = 'partial'; }
  }
  return report;
}

async function lineOutcome(root: string, manifest: Manifest, job: string): Promise<BatchLineOutcome> {
  const detail = manifest.results?.[job];
  const state = manifest.handled?.[job] ?? manifest.outcomes?.[job] ?? detail?.outcome;
  const reason = detail?.reason ? scrubPrivateText(stripVTControlCharacters(detail.reason)).replace(/[\r\n]/g, ' ').slice(0, 500) : null;
  const result: BatchLineOutcome = { job, outcome: 'unknown', pr: null, reason, autoMerge: 'unknown' };
  if (state === 'failed' || state === 'deferred' || state === 'released') {
    return { ...result, outcome: 'failed', reason: reason ?? 'Line failed or was deferred; retry is separate.' };
  }
  if (state !== 'done' && state !== 'skipped') return result;
  try {
    // Job IDs are reused. Both the handoff owner and receipt age must match this session.
    const owner = await snapshot(join(root, 'queue', 'run', `${job}.bundled-in`), 256);
    const receipt = await snapshot(join(root, `${job}.publish`), 1024 * 1024);
    if (owner.text.trim() !== manifest.id || receipt.modified < manifest.created_at * 1000) return result;
    const rows = receipt.text.split(/\r?\n/);
    const boundaries = rows.flatMap((line, index) => line.startsWith('RESULT ') ? [index] : []);
    const last = rows[boundaries.at(-1) ?? -1] ?? '';
    const pr = /^RESULT PR (https:\/\/github\.com\/ashlrai\/([A-Za-z0-9._-]+)\/pull\/[1-9][0-9]*)(?:\s|$)/.exec(last);
    if (pr && pr[2] === manifest.repo) {
      // Same publisher vocabulary as fleet job detail; absent evidence stays unknown.
      const segment = rows.slice((boundaries.at(-2) ?? -1) + 1).join('\n');
      const am = [...segment.matchAll(/^AUTO_MERGE (on|off)\b/gm)].at(-1)?.[1];
      return { ...result, outcome: 'pr', pr: pr[1], reason: null, autoMerge: am === 'on' ? 'armed' : am === 'off' ? 'off' : 'unknown' };
    }
    if (/^RESULT EMPTY(?:\s|$)/.test(last)) {
      return { ...result, outcome: 'empty', reason: reason ?? 'Publisher reported no changes to publish.' };
    }
    if (/^RESULT (?:ABORT|DENIED|FAILED|ERROR)(?:\s|$)/.test(last)) {
      return { ...result, outcome: 'failed', reason: 'Publisher refused or failed this line.' };
    }
  } catch { /* Missing, oversized or unreadable evidence remains unknown. */ }
  return result;
}

/** Read the dispatcher's existing per-line manifests; no launch, publication or GitHub calls. */
export async function readQueueBatches(root = join(homedir(), '.ashlr-runs')): Promise<QueueBatchReport> {
  const report: QueueBatchReport = { schema: 'phantom.queue-batches.v1', evidence: 'available', sessions: [], totals: null, ranking: null,
    emptyPrefixes: await readEmptyPrefixes(root, Date.now()), routeSkips: await readRouteSkips(root),
    superseded: await supersedeQueue({ runsDir: root }).then(plan => plan.count, () => null),
    gaps: ['Publication and auto-merge reflect local receipts; missing evidence is unknown, not live GitHub state.'] };
  try {
    const ranking = rankingSchema.parse(JSON.parse((await snapshot(join(root, 'queue', 'ranking.json'), 4 * 1024 * 1024)).text));
    if (Date.now() / 1000 - ranking.at >= 0 && Date.now() / 1000 - ranking.at <= 300) report.ranking = ranking;
  } catch { /* Missing or invalid ranking evidence stays unknown. */ }
  report.gaps.push('Ranking uses resolved solo launches and explicit pr= targets; pending outcomes and live GitHub state are unknown.');
  let names: string[];
  try { names = (await readdir(join(root, 'queue', 'batches'))).filter(name => name.endsWith('.json')).sort(); }
  catch { return { ...report, evidence: 'unknown', gaps: [...report.gaps, 'Batch manifests are unavailable.'] }; }
  if (names.length > 1000) { report.evidence = 'partial'; report.gaps.push('Only the first 1000 manifests were read.'); }
  for (const name of names.slice(0, 1000)) {
    // Node-bridge leases (RQ-BATCH-NODE-*) share the directory dispatchd checks; they are not batch sessions.
    if (name.startsWith('RQ-BATCH-NODE-')) continue;
    try {
      const raw = await snapshot(join(root, 'queue', 'batches', name), 2 * 1024 * 1024);
      const manifest = manifestSchema.parse(JSON.parse(raw.text));
      if (name !== `${manifest.id}.json`) throw new Error('Manifest identity mismatch');
      const outcomes = await Promise.all(manifest.members.map(m => lineOutcome(root, manifest, m.job)));
      report.sessions.push({ id: manifest.id, repo: manifest.repo, area: scrubPrivateText(manifest.area), outcomes });
    } catch { report.evidence = 'partial'; }
  }
  if (report.evidence === 'partial') report.gaps.push('Counts cover readable manifests only; other sessions are unknown.');
  const lines = report.sessions.flatMap(session => session.outcomes);
  report.totals = { sessions: report.sessions.length, lines: lines.length, pr: 0, empty: 0, failed: 0, unknown: 0 };
  for (const line of lines) report.totals[line.outcome]++;
  return report;
}

export function formatQueueBatches(report: QueueBatchReport): string {
  const n = report.totals;
  const prs = report.sessions.flatMap(session => session.outcomes).filter(line => line.outcome === 'pr');
  const armed = prs.filter(line => line.autoMerge === 'armed').length;
  const off = prs.filter(line => line.autoMerge === 'off').length;
  const skips = report.routeSkips.skips;
  // One plain line, only when a ready job sits on a lane that cannot do it.
  const wrong = skips.length ? `\n${skips.length} ready ${skips.length === 1 ? 'job sits' : 'jobs sit'} on a lane that cannot do the work (${[...new Set(skips.map(s => s.code))].join('; ')}): ${skips.slice(0, 5).map(s => s.job).join(', ')}${skips.length > 5 ? ' and more' : ''}.` : '';
  const old = report.superseded ?? 0;
  const stale = old ? `\n${old} queued ${old === 1 ? 'job has' : 'jobs have'} a newer cycle queued. Run phm queue supersede --apply to archive ${old === 1 ? 'it' : 'them'}.` : '';
  return (n ? `${n.sessions} sessions, ${n.lines} lines: ${n.pr} PRs, ${n.empty} empty, ${n.failed} failed, ${n.unknown} unknown; auto-merge ${armed} armed, ${off} off, ${prs.length - armed - off} unknown${report.evidence === 'partial' ? '; incomplete evidence' : ''}.`
    : 'Batch sessions unknown: evidence unavailable; auto-merge unknown.') + wrong + stale;
}
