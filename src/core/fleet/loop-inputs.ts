import { redactKnownValues, scrubPrivateText } from '../util/scrub.js';
import { LOOP_REPOS, nonnegative, row, time, type LoopCost, type LoopPr, type Row } from './loop.js';

export interface QueueClaim { repo: string; pr: number | null; task: string | null; queued_at: string | null; claimed_at: string | null; agent: string | null }
export interface Parsed<T> { values: T[]; complete: boolean }
function identity(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const deny = Object.entries(process.env).filter(([key]) => /token|secret|password|credential|key|auth/i.test(key)).map(([, val]) => val);
  const text = scrubPrivateText(redactKnownValues(value, deny), { emails: true });
  return Array.from(text).filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 120);
}
function iso(value: unknown): string | null {
  const ms = time(value);
  return ms === null ? null : new Date(ms).toISOString();
}
/** Header-driven tables; do not infer dates from file mtimes or queue ordering. */
export function parseLoopQueue(text: string): Parsed<QueueClaim> {
  const values: QueueClaim[] = [];
  let complete = true, headers: string[] = [], sawHeader = false;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim().replace(/`/g, ''));
    const keys = cells.map(cell => cell.toLowerCase().replace(/[\s-]+/g, '_'));
    if (keys.includes('repo') && (keys.includes('queued') || keys.includes('queued_at'))) { headers = keys; sawHeader = true; continue; }
    if (!headers.length || cells.every(cell => /^[-: ]*$/.test(cell))) continue;
    const fields = Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? '']));
    const repo = fields['repo']?.replace(/^https:\/\/github.com\//, '').replace(/\/$/, '');
    const canonical = repo?.includes('/') ? repo : `ashlrai/${repo}`;
    const prText = fields['pr'] ?? fields['pull_request'] ?? '';
    const prMatch = prText.match(/^(?:#)?(\d+)$/) ?? prText.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    const pr = prMatch ? Number(prMatch[1]) : null;
    const task = fields['task'] ?? fields['id'] ?? null;
    if (!LOOP_REPOS.includes(canonical) || (!pr && !task)) { complete = false; continue; }
    const queued = iso(fields['queued_at'] ?? fields['queued']);
    const rawClaimed = fields['claimed_at'] ?? fields['claimed'];
    const claimed = iso(rawClaimed);
    const linkedRepo = prText.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1];
    if (linkedRepo && linkedRepo !== canonical) { complete = false; continue; }
    if (!queued || (!claimed && rawClaimed && !['-', '—', 'pending'].includes(rawClaimed)) ||
      (queued && claimed && time(claimed)! < time(queued)!)) complete = false;
    values.push({ repo: canonical, pr, task, queued_at: queued, claimed_at: claimed, agent: identity(fields['agent'] ?? fields['claimed_by']) });
  }
  return { values, complete: complete && sawHeader };
}

export interface CiTime { repo: string; pr: number; head_sha: string; duration_ms: number; recorded_at: number }
/** ci_time.v1 is a per-head total, not an additional check to add to GitHub's total. */
export function parseCiTimes(text: string): Parsed<CiTime> {
  const values: CiTime[] = [];
  let complete = true;
  for (const line of text.split('\n').filter(line => line.trim())) {
    try {
      const value = row(JSON.parse(line));
      const duration = nonnegative(value['duration_ms'] ?? value['ci_time_ms']);
      const recorded = time(value['recorded_at'] ?? value['ts']);
      const pr = value['pr'];
      if (value['schema'] !== 'ci_time.v1' || !LOOP_REPOS.includes(String(value['repo'])) ||
          !Number.isSafeInteger(pr) || Number(pr) <= 0 || typeof value['head_sha'] !== 'string' ||
          !/^[a-f0-9]{40}$/i.test(value['head_sha']) || duration === null || recorded === null) {
        complete = false; continue;
      }
      values.push({ repo: String(value['repo']), pr: Number(pr), head_sha: value['head_sha'], duration_ms: duration, recorded_at: recorded });
    } catch { complete = false; }
  }
  return { values, complete };
}

/** A fresh priced snapshot supplies a reproducible window; wall-clock equality is never required. */
export function loopWindowEnd(fleet: Row, now: number): number {
  const spend = row(fleet['spend']);
  const candidate = spend['complete'] === true ? spend : Array.isArray(fleet['pools']) ? row(fleet['pools'][0]) : {};
  const start = time(candidate['window_start']), end = time(candidate['window_end']);
  return start !== null && end !== null && end - start === 7 * 86400_000 && end <= now && now - end <= 5 * 60_000 ? end : now;
}

export function loopCosts(fleet: Row, prs: LoopPr[], now: number): { cost: LoopCost; complete: boolean } {
  const start = now - 7 * 86400_000;
  let usd: number | null = null, points: number | null = null, unattributed = 0;
  const agents = new Map<string, { points: number; merges: Set<string> }>();
  let complete = true;
  // An explicit spend ledger includes all consumed work, including work that did not merge.
  const spend = row(fleet['spend']);
  const aligned = time(spend['window_start']) === start && time(spend['window_end']) === now;
  if (aligned && spend['complete'] === true && Array.isArray(spend['entries'])) {
    usd = 0;
    for (const item of spend['entries']) {
      const entry = row(item), at = time(entry['at']);
      if (at === null || at < start || at > now) { complete = false; usd = null; continue; }
      const dollars = nonnegative(entry['usd']);
      if (dollars === null) usd = null;
      else if (usd !== null) usd += dollars;
      if (entry['pool'] !== 'grok-ultra-weekly') continue;
      const amount = nonnegative(entry['points']);
      if (amount === null) { complete = false; continue; }
      points = (points ?? 0) + amount;
      const matching = prs.find(pr => pr.repo === entry['repo'] && pr.number === entry['pr']);
      const agent = identity(entry['agent']) ?? matching?.agent ?? null;
      if (!agent) { unattributed += amount; continue; }
      const data = agents.get(agent) ?? { points: 0, merges: new Set<string>() };
      data.points += amount;
      // Only associate the consuming agent with merges evidenced for its work.
      if (matching?.merged_at) data.merges.add(`${matching.repo}#${matching.number}`);
      agents.set(agent, data);
    }
    // An explicitly complete empty Ultra ledger proves zero, unlike a percentage reading.
    if (points === null && !spend['entries'].some(item => row(item)['pool'] === 'grok-ultra-weekly')) points = 0;
  } else {
    // A fleet may expose window-scoped USD totals directly on every pool.
    const pools = Array.isArray(fleet['pools']) ? fleet['pools'].map(row) : [];
    if (pools.length && new Set(pools.map(pool => pool['id'])).size === pools.length && pools.every(pool =>
      typeof pool['id'] === 'string' && !pool['shared_with'] && pool['complete'] === true &&
      time(pool['window_start']) === start && time(pool['window_end']) === now && nonnegative(pool['spend_usd']) !== null)) {
      usd = pools.reduce((sum, pool) => sum + Number(pool['spend_usd']), 0);
    }
  }
  if (!complete) points = null;
  return { cost: { pool_spend_usd: usd, merged_prs_per_dollar: null, grok_ultra_points: points,
    grok_ultra_points_per_merged_pr: null, unattributed_points: points === null ? null : unattributed,
    by_agent: [...agents].map(([agent, data]) => ({ agent, points: data.points, merged_prs: data.merges.size,
      points_per_merged_pr: data.merges.size ? data.points / data.merges.size : null })) }, complete: complete && usd !== null && points !== null };
}
