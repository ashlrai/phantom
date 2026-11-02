/** One bounded discovery pass; the existing publisher owns incident construction and dedupe. */
import { tmpdir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import type { BusInboxOptions } from './bus-inbox.js';
import { publishCiIncident, validCiPublishInput } from './ci-bus-incident.js';

const MAX_BYTES = 1024 * 1024, PAGE_SIZE = 25, MAX_PAGES = 2, MAX_SELECTED = 10;
const STATUSES = new Set(['completed', 'in_progress', 'queued', 'requested', 'waiting', 'pending']);
const CONCLUSIONS = new Set(['action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out']);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: 30_000, maxStdoutBytes: MAX_BYTES });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: '' };
};

type PublisherResult = Awaited<ReturnType<typeof publishCiIncident>>;
type Outcome = { run: string | null; result: PublisherResult };
export async function sweepScheduledCi(input: { repo: string; to: string; dryRun: boolean },
  deps: { gh?: CloudGh; bus?: BusInboxOptions } = {}) {
  const report = { discovered: 0, selected: 0, posted: 0, duplicate: 0, skipped: 0, error: 0, previewed: 0,
    listing: { complete: false, pages: 0, total: null as number | null, reason: null as string | null },
    capOmissions: 0, outcomes: [] as Outcome[] };
  if (!validCiPublishInput(input.repo, '1', input.to)) {
    report.error++; report.listing.reason = 'invalid input'; return report;
  }
  const repo = input.repo.toLowerCase(), gh = deps.gh ?? defaultGh;
  const candidates: { run: string; created: number }[] = [], ids = new Set<number>();
  let invalidRows = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data: unknown;
    try {
      const result = await gh(['api', '--hostname', 'github.com', '--method', 'GET',
        `repos/${repo}/actions/runs?event=schedule&per_page=${PAGE_SIZE}&page=${page}`]);
      if (!result.ok || Buffer.byteLength(result.stdout, 'utf8') > MAX_BYTES) throw new Error('read');
      data = JSON.parse(result.stdout) as unknown;
    } catch { report.listing.reason = 'GitHub listing read failed'; break; }
    if (!record(data) || typeof data.total_count !== 'number' || !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 || !Array.isArray(data.workflow_runs) || data.workflow_runs.length > PAGE_SIZE ||
        (report.listing.total !== null && data.total_count !== report.listing.total)) {
      report.listing.reason = 'invalid or inconsistent GitHub listing'; break;
    }
    report.listing.pages++;
    report.listing.total = data.total_count;
    const rows = data.workflow_runs as unknown[];
    report.discovered += rows.length;
    for (const row of rows) {
      const timestamp = record(row) && typeof row.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(row.created_at)
        ? Date.parse(row.created_at) : NaN;
      if (!record(row) || !positive(row.id) || ids.has(row.id) || !record(row.repository) ||
          typeof row.repository.full_name !== 'string' || row.repository.full_name.toLowerCase() !== repo ||
          typeof row.event !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(row.event) ||
          typeof row.status !== 'string' || !STATUSES.has(row.status) ||
          !(row.conclusion === null || (typeof row.conclusion === 'string' && CONCLUSIONS.has(row.conclusion))) || !Number.isFinite(timestamp) ||
          new Date(timestamp).toISOString() !== String(row.created_at).replace('Z', '.000Z')) {
        invalidRows = true; report.error++;
        report.outcomes.push({ run: null, result: { status: 'error', reason: 'invalid GitHub listing run metadata' } });
        continue;
      }
      ids.add(row.id);
      if (row.event !== 'schedule' || row.status !== 'completed' || row.conclusion !== 'failure') {
        report.skipped++; report.outcomes.push({ run: String(row.id), result: { status: 'skipped', reason: 'not a completed scheduled failure' } });
      } else candidates.push({ run: String(row.id), created: timestamp });
    }
    const expected = Math.min(PAGE_SIZE, Math.max(0, data.total_count - (page - 1) * PAGE_SIZE));
    if (rows.length !== expected) { report.listing.reason = 'incomplete GitHub listing'; break; }
    if (report.discovered >= data.total_count) { report.listing.complete = !invalidRows; break; }
  }
  if (!report.listing.complete) {
    report.listing.reason ??= invalidRows ? 'invalid GitHub listing run metadata' : 'GitHub listing page limit reached';
    // Invalid rows are already counted individually.
    if (!invalidRows || report.listing.reason !== 'invalid GitHub listing run metadata') report.error++;
  }
  candidates.sort((a, b) => b.created - a.created || Number(b.run) - Number(a.run));
  report.selected = Math.min(candidates.length, MAX_SELECTED);
  report.capOmissions = candidates.length - report.selected;
  for (const candidate of candidates.slice(0, MAX_SELECTED)) {
    let result: PublisherResult;
    try { result = await publishCiIncident({ ...input, run: candidate.run }, { ...deps, gh }); }
    catch { result = { status: 'error', reason: 'incident publish failed' }; }
    if (result.status === 'dry-run') report.previewed++;
    else report[result.status]++;
    report.outcomes.push({ run: candidate.run, result });
  }
  return report;
}
