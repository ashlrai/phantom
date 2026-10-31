export interface Merged { repo: string; number: number; title: string; href: string | null; job: string | null; lane: string | null; at: string | null }
export interface Pending { job: string; lane: string | null; href: string | null; at: string }
/** mergeRate24h is a percentage. */
export interface Lane { lane: string; merged24h: number | null; mergeRate24h: number | null }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
// Server rollup_24h.by_lane.<lane>.merge_rate: [0, 1] is a fraction, (1, 100] a percentage; other values are unknown.
const rate = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? (value <= 1 ? value * 100 : value) : null;
const prHref = (value: unknown): string | null => typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9._-]*\/pull\/[1-9][0-9]*$/.test(value) ? value : null;

export function readMerges(snapshot: unknown): { merged: Merged[]; pending: Pending[]; lanes: Lane[]; count: number | null; sourceState: string | null } {
  const data = record(snapshot), merges = record(data.mergesLastHour), sources = record(data.sources);
  const publishes = Array.isArray(data.publishesLastHour) ? data.publishesLastHour.map(record) : [];
  const merged: Merged[] = (Array.isArray(merges.items) ? merges.items : []).flatMap(raw => {
    const item = record(raw), number = count(item.number);
    if (typeof item.repo !== 'string' || number === null || number === 0 || typeof item.title !== 'string') return [];
    const href = prHref(`https://github.com/${item.repo}/pull/${number}`);
    const publish = publishes.find(p => href && prHref(p.url) === href);
    const job = typeof publish?.job === 'string' ? publish.job : item.title.match(/\bRQ-[A-Za-z0-9._-]+\b/)?.[0] ?? null;
    return [{ repo: item.repo, number, title: item.title, href, job, lane: typeof publish?.lane === 'string' ? publish.lane : null, at: typeof publish?.at === 'string' ? publish.at : null }];
  }).sort((a, b) => b.number - a.number);
  const pending: Pending[] = (Array.isArray(data.publishesLastHour) ? data.publishesLastHour : []).flatMap(raw => {
    const item = record(raw);
    if (typeof item.job !== 'string' || !item.job || typeof item.at !== 'string' || merged.some(merge => merge.title.includes(item.job as string))) return [];
    return [{ job: item.job, lane: typeof item.lane === 'string' ? item.lane : null, href: prHref(item.url), at: item.at }];
  }).sort((a, b) => {
    const left = Date.parse(a.at), right = Date.parse(b.at);
    return (Number.isFinite(right) ? right : -Infinity) - (Number.isFinite(left) ? left : -Infinity) || 0;
  });
  const lanes: Lane[] = (Array.isArray(data.lanes) ? data.lanes : []).flatMap(raw => {
    const item = record(raw);
    return typeof item.lane === 'string' ? [{ lane: item.lane, merged24h: count(item.merged24h), mergeRate24h: rate(item.mergeRate24h) }] : [];
  }).sort((a, b) => a.merged24h === null ? (b.merged24h === null ? 0 : 1) : b.merged24h === null ? -1 : b.merged24h - a.merged24h);
  return { merged, pending, lanes, count: count(merges.count), sourceState: typeof sources.merges === 'string' ? sources.merges : null };
}
