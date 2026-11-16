import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { scrubPrivateText } from '../util/scrub.js';

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
export interface BatchLineOutcome {
  job: string; outcome: 'pr' | 'empty' | 'failed' | 'unknown';
  pr: string | null; reason: string | null; autoMerge: 'armed' | 'off' | 'unknown';
}
export interface QueueBatchReport {
  schema: 'phantom.queue-batches.v1'; evidence: 'available' | 'partial' | 'unknown';
  sessions: Array<{ id: string; repo: string; area: string; outcomes: BatchLineOutcome[] }>;
  totals: { sessions: number; lines: number; pr: number; empty: number; failed: number; unknown: number } | null;
  gaps: string[];
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
  const report: QueueBatchReport = { schema: 'phantom.queue-batches.v1', evidence: 'available', sessions: [], totals: null,
    gaps: ['Publication and auto-merge reflect local receipts; missing evidence is unknown, not live GitHub state.'] };
  let names: string[];
  try { names = (await readdir(join(root, 'queue', 'batches'))).filter(name => name.endsWith('.json')).sort(); }
  catch { return { ...report, evidence: 'unknown', gaps: [...report.gaps, 'Batch manifests are unavailable.'] }; }
  if (names.length > 1000) { report.evidence = 'partial'; report.gaps.push('Only the first 1000 manifests were read.'); }
  for (const name of names.slice(0, 1000)) {
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
  return n ? `${n.sessions} sessions, ${n.lines} lines: ${n.pr} PRs, ${n.empty} empty, ${n.failed} failed, ${n.unknown} unknown; auto-merge ${armed} armed, ${off} off, ${prs.length - armed - off} unknown${report.evidence === 'partial' ? '; incomplete evidence' : ''}.`
    : 'Batch sessions unknown: evidence unavailable; auto-merge unknown.';
}
