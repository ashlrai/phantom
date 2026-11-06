import { formatRelative } from '../autonomy/format.js';
import type { CiRunFactsV1 } from './fleet-releases-queries.js';

export function dailyCiLine(facts: CiRunFactsV1 | undefined, nowMs: number): { tone: 'ok' | 'bad' | 'stale' | 'none'; text: string; detail: string | null; url: string | null } {
  const none = { tone: 'none', text: '', detail: null, url: null } as const;
  const daily = facts?.available ? facts.daily : null;
  if (!daily || !Number.isFinite(Date.parse(daily.createdAt))) return none;
  const relative = formatRelative(daily.createdAt, nowMs).replace(/^(\d+)([smhd]) ago$/, (_, n: string, unit: string) => {
    const label = ({ s: 'sec', m: 'min', h: 'h', d: 'day' } as Record<string, string>)[unit];
    return `${n} ${label}${unit === 'd' && n !== '1' ? 's' : ''} ago`;
  });
  const url = /^https:\/\/github\.com\//i.test(daily.url) ? daily.url : null;
  if (nowMs - Date.parse(daily.createdAt) > 36 * 60 * 60 * 1000) {
    return { tone: 'stale', text: `Daily CI has not run for ${relative.replace(/ ago$/, '')}`, detail: null, url };
  }
  if (daily.conclusion !== 'success' && daily.conclusion !== 'failure') return none;
  const failedJobs = daily.failedJobs.slice(0, 6);
  const more = daily.failedJobs.length - failedJobs.length;
  return {
    tone: daily.conclusion === 'success' ? 'ok' : 'bad',
    text: `Daily CI ${daily.conclusion === 'success' ? 'green' : 'red'}, ran ${relative}`,
    detail: daily.conclusion === 'failure' && failedJobs.length ? `Failing: ${failedJobs.join(', ')}${more ? `, +${more} more` : ''}` : null,
    url,
  };
}
