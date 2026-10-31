import { formatRelative } from '../autonomy/format.js';
import { JOB_ID_RE, safePrUrl } from '../fleet-job-log/worker-log-model.js';
import type { readMerges } from './fleet-merges-model.js';

export function mergesMarkdown(data: ReturnType<typeof readMerges>, nowMs: number): string {
  if (!data.merged.length && !data.pending.length) return '';
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nowMs);
  const lines = [`${data.count ?? '—'} merged in the last hour · ${data.pending.length} publishes waiting · ${clock} ET`];
  for (const item of data.merged) {
    const url = safePrUrl(item.href);
    const lane = item.lane && /^[A-Za-z0-9._-]+$/.test(item.lane) ? item.lane : '—';
    lines.push(`- ${item.job && JOB_ID_RE.test(item.job) ? item.job : '—'} · ${lane} · ${formatRelative(item.at, nowMs)}${url?.startsWith('https://') ? ` · ${url}` : ''}`);
  }
  if (data.pending.length) lines.push(`Waiting: ${data.pending.map(item => JOB_ID_RE.test(item.job) ? item.job : '—').join(', ')}`);
  return lines.join('\n');
}
