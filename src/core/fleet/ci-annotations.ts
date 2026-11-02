import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;

export function validCiRepo(repo: string): boolean {
  const [owner, name] = repo.split('/');
  return REPO.test(repo) && !owner!.endsWith('-') && !owner!.includes('--') && name !== '.' && name !== '..';
}
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ''));
}
function safePath(path: string): boolean {
  // Reject control characters, backslashes and ambiguous components before sanitizing.
  // eslint-disable-next-line no-control-regex
  return path.length > 0 && path.length <= 4096 && !/[\x00-\x1f\x7f-\x9f\\]/.test(path) &&
    !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.split('/').some((s) => !s || s === '.' || s === '..');
}

export interface CiAnnotation {
  level: string; path: string; startLine: number; endLine: number;
  startColumn: number | null; endColumn: number | null; title: string; message: string;
}
export interface CiAnnotations {
  version: 1; repo: string; job: number; run: number | null; check: number | null; headSha: string | null;
  source: { status: 'ok' | 'job_unavailable' | 'job_invalid' | 'job_truncated' | 'annotations_unavailable' | 'annotations_invalid' | 'annotations_truncated'; truncated: boolean; outputTruncated: boolean };
  annotations: CiAnnotation[];
}

/** Read only the requested GitHub job and its validated check run. */
export async function readCiAnnotations(repo: string, job: number, runner: GitRunner = defaultGitRunner): Promise<CiAnnotations> {
  if (!validCiRepo(repo) || !positive(job)) throw new Error('Invalid repository or job ID');
  const out: CiAnnotations = { version: 1, repo, job, run: null, check: null, headSha: null,
    source: { status: 'job_unavailable', truncated: false, outputTruncated: false }, annotations: [] };
  const read = async (endpoint: string) => {
    try { return await runner('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint],
      { cwd: tmpdir(), timeoutMs: TIMEOUT_MS, maxStdoutBytes: MAX_BYTES }); } catch { return null; }
  };
  const response = await read(`repos/${repo}/actions/jobs/${job}`);
  if (response?.truncated) { out.source.status = 'job_truncated'; out.source.truncated = true; return out; }
  if (!response || response.code !== 0 || response.timedOut || response.missing) return out;
  let data: Record<string, unknown> | null;
  try { data = record(JSON.parse(response.stdout)); } catch { data = null; }
  const link = typeof data?.['check_run_url'] === 'string' ? data['check_run_url'] : '';
  const prefix = `https://api.github.com/repos/${repo}/check-runs/`;
  const suffix = link.startsWith(prefix) ? link.slice(prefix.length) : '';
  const check = /^\d+$/.test(suffix) ? Number(suffix) : 0;
  if (!data || data['id'] !== job || !positive(data['run_id']) || !positive(check) ||
      typeof data['head_sha'] !== 'string' || !/^[a-f\d]{40,64}$/i.test(data['head_sha'])) {
    out.source.status = 'job_invalid'; return out;
  }
  out.run = data['run_id']; out.check = check; out.headSha = data['head_sha'];
  const limit = (value: string, max: number): string => {
    const safe = clean(value);
    if (safe.length > max) out.source.outputTruncated = true;
    return safe.slice(0, max);
  };
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await read(`repos/${repo}/check-runs/${check}/annotations?per_page=${PAGE_SIZE}&page=${page}`);
    if (res?.truncated) { out.source.status = 'annotations_truncated'; out.source.truncated = true; return out; }
    if (!res || res.code !== 0 || res.timedOut || res.missing) { out.source.status = 'annotations_unavailable'; return out; }
    let rows: unknown;
    try { rows = JSON.parse(res.stdout); } catch { rows = null; }
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) { out.source.status = 'annotations_invalid'; return out; }
    for (const item of rows) {
      const row = record(item);
      const start = row?.['start_line'], end = row?.['end_line'];
      const sc = row?.['start_column'], ec = row?.['end_column'];
      if (!row || typeof row['path'] !== 'string' || !safePath(row['path']) ||
          !positive(start) || !positive(end) || end < start ||
          !(sc === null && ec === null || positive(sc) && positive(ec) && start === end && ec >= sc) ||
          !['notice', 'warning', 'failure'].includes(String(row['annotation_level'])) ||
          !(row['title'] === null || typeof row['title'] === 'string') || typeof row['message'] !== 'string') {
        out.source.status = 'annotations_invalid'; return out;
      }
      out.annotations.push({ level: row['annotation_level'] as string, path: limit(row['path'], 4096),
        startLine: start, endLine: end, startColumn: sc as number | null, endColumn: ec as number | null,
        title: limit(row['title'] ?? '', 200), message: limit(row['message'], 2000) });
    }
    if (rows.length < PAGE_SIZE) { out.source.status = 'ok'; return out; }
  }
  out.source.status = 'annotations_truncated'; out.source.truncated = true;
  return out;
}
