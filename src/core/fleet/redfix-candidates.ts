import { stripVTControlCharacters } from 'node:util';
import { defaultGh, type Gh } from '../autopilot/github.js';

type Check = { name: string; status: string; conclusion: string; startedAt: string; detailsUrl: string; log?: string };
export type RedfixPr = { number: number; title: string; statusCheckRollup: Check[] };
export type RedfixMerged = { title: string; body: string };
export type RedfixCandidate = { pr: number; bucket: 'TYPE' | 'TEST' | null; failingCheck: string | null; kept: boolean; reason: string };
const repo = 'ashlrai/phantom';
const stem = (title: string): string | undefined => /\bRQ-PHX-[A-Z0-9-]+\b/i.exec(title)?.[0].replace(/C\d+[BCD]?$/i, '').toUpperCase();
const bridge = /^(?:bridge:\s*RQ-PHX-|bridge\(RQ-PHX-)/i;
const latestChecks = (pr: RedfixPr): Check[] => [...new Map((pr.statusCheckRollup ?? []).filter(c => typeof c.name === 'string')
  .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')).map(c => [c.name, c])).values()];

/** Pure eligibility rule. Only the newest attempt of each head check can supply evidence. */
export function redfixCandidate(pr: RedfixPr, merged: readonly RedfixMerged[]): RedfixCandidate {
  const row: RedfixCandidate = { pr: pr.number, bucket: null, failingCheck: null, kept: false, reason: 'not a bridge PR' };
  if (!bridge.test(pr.title)) return row;
  if (merged.some(m => stem(m.title) === stem(pr.title) || new RegExp(`\\bSupersedes\\s+#${pr.number}\\b`, 'i').test(m.body))) {
    return { ...row, reason: 'merged successor' };
  }
  const checks = latestChecks(pr);
  if (checks.some(c => c.status !== 'COMPLETED')) return { ...row, reason: 'CI incomplete' };
  for (const check of checks) {
    if (check.conclusion !== 'FAILURE') continue;
    const log = stripVTControlCharacters(check.log ?? '');
    const bucket = /\berror TS\d+:/.test(log) ? 'TYPE' : /(?:\bAssertionError:|\bTests\s+\d+ failed|\bFAIL\s+[^\n]+\.(?:test|spec)\.)/.test(log) ? 'TEST' : null;
    if (bucket) return { ...row, bucket, failingCheck: stripVTControlCharacters(check.name), kept: true, reason: 'real code failure' };
  }
  return { ...row, reason: 'no real test or type failure in latest CI' };
}

/** One read-only scan; capped or unavailable evidence throws instead of reporting an empty scan. */
export async function readRedfixCandidates(gh: Gh = defaultGh): Promise<RedfixCandidate[]> {
  const list = async <T>(state: string, fields: string, limit: number): Promise<T[]> => {
    const rows = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', fields])) as T[];
    if (!Array.isArray(rows) || rows.length >= limit) throw new Error('PR list unavailable or incomplete');
    return rows;
  };
  const open = await list<RedfixPr>('open', 'number,title,statusCheckRollup', 1000);
  const merged = await list<RedfixMerged>('merged', 'title,body', 10000);
  const rows: RedfixCandidate[] = [];
  for (const pr of open.filter(pr => bridge.test(pr.title))) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error('Invalid PR number');
    // Skip successors and pending CI before downloading any logs.
    const initial = redfixCandidate(pr, merged);
    if (initial.reason !== 'merged successor' && initial.reason !== 'CI incomplete') {
      for (const check of latestChecks(pr)) {
        if (check.conclusion !== 'FAILURE') continue;
        const job = /^https:\/\/github\.com\/ashlrai\/phantom\/actions\/runs\/\d+\/job\/(\d+)(?:\?.*)?$/.exec(check.detailsUrl);
        if (!job) continue;
        check.log = await gh(['api', `repos/${repo}/actions/jobs/${job[1]}/logs`]);
      }
    }
    rows.push(redfixCandidate(pr, merged));
  }
  return rows;
}

/** Integration seam for the external C-cycle emitter: scan once, then write only these READY rows. */
export async function planRedfixCycle(cycle: number, read = readRedfixCandidates, log = console.error): Promise<string[]> {
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error('Invalid cycle');
  const candidates = await read(), buckets = new Set<string>();
  const rows = candidates.filter(c => {
    if (!c.kept || !c.bucket || buckets.has(c.bucket)) return false;
    buckets.add(c.bucket); return true;
  }).map(c => `- READY RQ-PHX-RED${c.bucket}FIXC${cycle} (P1, pool=codex-personal, tier=work, repo=phantom): Fix PR #${c.pr}; skip candidate discovery. Recheck its head and CI before editing; stop if resolved. Include Supersedes #${c.pr} in BRIDGE_NOTES.md. Leave changes uncommitted.`);
  if (!rows.length) log('redfix: 0 eligible red PRs, no cycle emitted');
  return rows;
}
