import { matchesGlob } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { defaultGh, type Gh } from '../autopilot/github.js';

type Check = { name: string; status: string; conclusion: string; startedAt: string; detailsUrl: string; log?: string };
export type RedfixPr = { number: number; title: string; headRefName: string; updatedAt: string; files: { path: string }[]; changedFiles?: number; body?: string; statusCheckRollup: Check[] };
export type RedfixMerged = { title: string; body: string };
export type RedfixCandidate = { pr: number; bucket: 'TYPE' | 'TEST' | null; failingCheck: string | null; kept: boolean; reason: string };
const repo = 'ashlrai/phantom';
const stem = (title: string): string | undefined => /\bRQ-[A-Z0-9-]+\b/i.exec(title)?.[0].replace(/C\d+[BCD]?$/i, '').toUpperCase();
const bridge = /^(?:bridge:\s*RQ-|bridge\(RQ-)/i;
const latestChecks = (pr: RedfixPr): Check[] => [...new Map((pr.statusCheckRollup ?? []).filter(c => typeof c.name === 'string')
  .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')).map(c => [c.name, c])).values()];

/** Pure eligibility rule. Only the newest attempt of each head check can supply evidence. */
export function redfixCandidate(pr: RedfixPr, merged: readonly RedfixMerged[]): RedfixCandidate {
  const row: RedfixCandidate = { pr: pr.number, bucket: null, failingCheck: null, kept: false, reason: 'not a bridge PR' };
  if (!bridge.test(pr.title)) return row;
  if (merged.some(m => (stem(pr.title) !== undefined && stem(m.title) === stem(pr.title)) || new RegExp(`\\bSupersedes\\s+#${pr.number}\\b`, 'i').test(m.body))) {
    return { ...row, reason: 'merged successor' };
  }
  const checks = latestChecks(pr);
  if (checks.some(c => c.status !== 'COMPLETED')) return { ...row, reason: 'CI incomplete' };
  for (const check of checks) {
    if (check.conclusion !== 'FAILURE' || /behind|out.of.date|up.to.date/i.test(check.name)) continue;
    const log = stripVTControlCharacters(check.log ?? '');
    const bucket = /\berror TS\d+:/.test(log) ? 'TYPE' : /(?:\bAssertionError:|\bTests\s+\d+ failed|\bFAIL\s+[^\n]+\.(?:test|spec)\.)/.test(log) ? 'TEST' : null;
    if (bucket) return { ...row, bucket, failingCheck: stripVTControlCharacters(check.name), kept: true, reason: 'real code failure' };
  }
  return { ...row, reason: 'no real test or type failure in latest CI' };
}

export const RED_BUCKETS = {
  COREFLEET: ['src/core/fleet/**'], CLI: ['src/cli/**'], CONSOLE: ['src/web-ui/**'],
  'COMMS/MCP': ['src/core/comms/**', 'src/core/comms-agent/**', 'src/core/mcp/**', 'src/mcp/**'],
  'LEADER/API': ['src/core/leader/**', 'src/api/**'], 'SCRIPTS/TEST': ['scripts/**', 'test/**'],
  'WEB/SERVER': ['src/core/web/**', 'src/core/website/**', 'src/server/**'],
} as const;
export type RedBucket = keyof typeof RED_BUCKETS;
export type RedScan = { open: RedfixPr[]; merged: RedfixMerged[] };
export type RedCandidates = { state: 'known' | 'unknown'; candidates: { number: number; title: string; failingCheck: string; files: string[] }[]; rejected: { number: number; why: string }[] };

/** Oldest untouched PR first; all changed paths must match the requested bucket. */
export function redCandidates(open: readonly RedfixPr[], paths: readonly string[], merged: readonly RedfixMerged[], now = Date.now()): RedCandidates {
  const result: RedCandidates = { state: 'known', candidates: [], rejected: [] };
  for (const pr of [...open].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.number - b.number)) {
    const row = redfixCandidate(pr, merged), files = pr.files?.map(f => f.path) ?? [];
    const superseded = [...merged, ...open.filter(p => p.number !== pr.number)].some(p => new RegExp(`\\bSupersedes\\s+#${pr.number}\\b`, 'i').test(p.body ?? ''));
    const why = superseded ? 'superseded' : !row.kept ? row.reason
      : !Number.isFinite(Date.parse(pr.updatedAt)) ? 'update time unknown'
      : now - Date.parse(pr.updatedAt) < 3 * 3600_000 ? 'updated within three hours'
      : !files.length ? 'changed files unknown'
      : !files.every(file => paths.some(glob => matchesGlob(file, glob))) ? 'files cross bucket scope' : null;
    if (why) result.rejected.push({ number: pr.number, why });
    else result.candidates.push({ number: pr.number, title: pr.title, failingCheck: row.failingCheck!, files });
  }
  return result;
}

/** One read-only scan; capped or unavailable evidence throws instead of reporting an empty scan. */
export async function readRedfixScan(gh: Gh = defaultGh): Promise<RedScan> {
  const list = async <T>(state: string, fields: string, limit: number): Promise<T[]> => {
    const rows = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--base', 'master', '--state', state, '--limit', String(limit), '--json', fields])) as T[];
    if (!Array.isArray(rows) || rows.length >= limit) throw new Error('PR list unavailable or incomplete');
    return rows;
  };
  const open = await list<RedfixPr>('open', 'number,title,headRefName,updatedAt,files,changedFiles,body,statusCheckRollup', 1000);
  const merged = await list<RedfixMerged>('merged', 'title,body', 10000);
  for (const pr of open.filter(pr => bridge.test(pr.title))) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error('Invalid PR number');
    if (!Array.isArray(pr.files) || (pr.changedFiles !== undefined && pr.changedFiles !== pr.files.length)) throw new Error('PR files unavailable or incomplete');
    if (!Number.isFinite(Date.parse(pr.updatedAt))) throw new Error('PR update time unavailable');
    if (Date.now() - Date.parse(pr.updatedAt) < 3 * 3600_000) continue;
    // Skip successors and pending CI before downloading any logs.
    const initial = redfixCandidate(pr, merged);
    if (initial.reason !== 'merged successor' && initial.reason !== 'CI incomplete') {
      for (const check of latestChecks(pr)) {
        if (check.conclusion !== 'FAILURE' || /behind|out.of.date|up.to.date/i.test(check.name)) continue;
        const job = /^https:\/\/github\.com\/ashlrai\/phantom\/actions\/runs\/\d+\/job\/(\d+)(?:\?.*)?$/.exec(check.detailsUrl);
        if (!job) throw new Error('CI log unavailable');
        check.log = await gh(['api', `repos/${repo}/actions/jobs/${job[1]}/logs`]);
      }
    }
  }
  return { open, merged };
}

export async function readRedfixCandidates(gh: Gh = defaultGh): Promise<RedfixCandidate[]> {
  const { open, merged } = await readRedfixScan(gh);
  return open.filter(pr => bridge.test(pr.title)).map(pr => redfixCandidate(pr, merged));
}

export async function readRedCandidates(bucket: RedBucket, read = readRedfixScan): Promise<RedCandidates> {
  try { const { open, merged } = await read(); return redCandidates(open, RED_BUCKETS[bucket], merged); }
  catch { return { state: 'unknown', candidates: [], rejected: [] }; }
}

/** Integration seam for the external C-cycle emitter: scan once for every path bucket. */
export async function planRedfixCycle(cycle: number, read = readRedfixScan, log = console.error): Promise<string[]> {
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error('Invalid cycle');
  const { open, merged } = await read(), rows: string[] = [], now = Date.now();
  for (const [bucket, paths] of Object.entries(RED_BUCKETS)) {
    const c = redCandidates(open, paths, merged, now).candidates[0];
    if (c) rows.push(`- READY RQ-PHX-REDFIX${bucket.replace(/\//g, '')}C${cycle} (P1, pool=codex-personal, tier=work, repo=phantom): Fix PR #${c.number} in ${bucket} (${paths.join(', ')}); skip candidate discovery. Recheck its head and CI before editing; stop if resolved. Include Supersedes #${c.number} in BRIDGE_NOTES.md. Leave changes uncommitted.`);
  }
  if (!rows.length) log('redfix: 0 eligible red PRs, no cycle emitted');
  return rows;
}
