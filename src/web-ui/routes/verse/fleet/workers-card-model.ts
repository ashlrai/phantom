const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const string = (v: unknown): string | null => typeof v === 'string' ? v : null;
export const validJob = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(v);
export interface Worker { job: string; repo: string; lane: string; tier: string; ageSeconds: number | null }
interface Publish { job: string; lane: string | null; url: string | null; at: string }
export interface Workers { v: 1; generatedAt: string; workers: Worker[]; publishesLastHour: Publish[]; sources: { workers: string }; switches: string[]; paused: boolean | null; runsDir: string }
export function narrowWorkers(v: unknown): Workers | null {
  if (!record(v) || v.v !== 1 || typeof v.generatedAt !== 'string' || !record(v.sources)
    || !['healthy', 'degraded', 'missing', 'not-landed'].includes(String(v.sources.workers))
    || !Array.isArray(v.workers) || !Array.isArray(v.publishesLastHour)) return null;
  const workers: Worker[] = [];
  for (const w of v.workers) {
    if (!record(w) || !validJob(w.job) || typeof w.repo !== 'string' || typeof w.lane !== 'string' || typeof w.tier !== 'string'
      || !(w.ageSeconds === null || (typeof w.ageSeconds === 'number' && Number.isFinite(w.ageSeconds) && w.ageSeconds >= 0))) return null;
    workers.push({ job: w.job, repo: w.repo, lane: w.lane, tier: w.tier, ageSeconds: w.ageSeconds });
  }
  const publishesLastHour: Publish[] = [];
  for (const row of v.publishesLastHour) {
    if (!record(row) || typeof row.job !== 'string' || typeof row.at !== 'string'
      || !(row.url === null || typeof row.url === 'string') || !(row.lane === null || typeof row.lane === 'string')) return null;
    publishesLastHour.push({ job: row.job, lane: row.lane, url: row.url, at: row.at });
  }
  return { v: 1, generatedAt: v.generatedAt, workers, publishesLastHour, sources: { workers: String(v.sources.workers) },
    switches: Array.isArray(v.switches) && v.switches.every(s => typeof s === 'string') ? v.switches : [],
    paused: typeof v.paused === 'boolean' ? v.paused : null, runsDir: typeof v.sources.runsDir === 'string' ? v.sources.runsDir : 'not-landed' };
}
export function emptyReason(data: Workers): { text: string; tone: 'neutral' | 'warning' | 'danger' } {
  if (data.switches.length) return { text: 'Dispatch is paused by HOLD', tone: 'danger' };
  if (data.paused) return { text: 'The dispatcher is paused', tone: 'warning' };
  if (data.runsDir === 'missing') return { text: 'No fleet on this Mac yet (~/.ashlr-runs not found)', tone: 'neutral' };
  return { text: 'No workers running. Leaders write jobs every 15 minutes.', tone: 'neutral' };
}
export function ageText(seconds: number): string {
  const s = Math.floor(seconds);
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
}
export const sortWorkers = (workers: Worker[]): Worker[] => [...workers].sort((a, b) => a.lane.localeCompare(b.lane) || (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1));
export const githubUrl = (url: string | null): string | null => url?.startsWith('https://github.com/') ? url : null;
export const publishFor = (job: string, publishes: Publish[]): string | null => githubUrl(publishes.find(p => p.job === job)?.url ?? null);
export const describeWorkers = (n: number): string => n === 0 ? 'No workers running' : `${n} worker${n === 1 ? '' : 's'} running`;
export function narrowJob(v: unknown) {
  if (!record(v) || v.schema !== 'fleet.job.v1' || !validJob(v.job) || !['running', 'published', 'archived', 'unknown'].includes(String(v.state))
    || !record(v.log) || !Array.isArray(v.log.tail) || !v.log.tail.every(line => typeof line === 'string')
    || !record(v.sources)) return null;
  const sources = v.sources;
  if (!['launch', 'base', 'meta', 'publish', 'log'].every(k => ['healthy', 'missing', 'degraded'].includes(String(sources[k])))) return null;
  return { job: v.job, state: String(v.state), lane: string(v.lane), tier: string(v.tier), model: string(v.model),
    launchedAt: string(v.launchedAt), baseSha: string(v.baseSha), branch: string(v.branch),
    publish: record(v.publish) ? { prUrl: githubUrl(string(v.publish.prUrl)), autoMerge: typeof v.publish.autoMerge === 'boolean' ? v.publish.autoMerge : null } : null,
    hasNotes: record(v.notes) && typeof v.notes.hasNotes === 'boolean' ? v.notes.hasNotes : null,
    log: { source: v.log.source === 'live' || v.log.source === 'archived' ? v.log.source : 'missing', tail: v.log.tail as string[], truncated: v.log.truncated === true } };
}
