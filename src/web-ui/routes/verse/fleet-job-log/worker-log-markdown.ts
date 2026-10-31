import { safePrUrl, type FleetJobDetailV1 } from './worker-log-model.js';

/* eslint-disable no-control-regex -- terminal escape sequences and control bytes must not be copied. */
const OSC = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const ESCAPE = /\u001B[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/* eslint-enable no-control-regex */

function clean(value: string): string {
  return value.replace(OSC, '').replace(CSI, '').replace(ESCAPE, '').replace(CONTROL, '');
}

export function workerLogMarkdown(job: string, detail: FleetJobDetailV1, nowMs: number, { maxLines = 60 }: { maxLines?: number } = {}): string {
  const report = [`### ${job}`];
  for (const [label, value] of [['Lane', detail.lane], ['Tier', detail.tier], ['Model', detail.model], ['State', detail.state]] as const) {
    if (typeof value === 'string' && value.trim() && value !== 'unknown') report.push(`- ${label}: ${clean(value).replace(/\n/g, ' ')}`);
  }
  const launched = typeof detail.launchedAt === 'string' ? Date.parse(detail.launchedAt) : NaN;
  if (Number.isFinite(launched) && Number.isFinite(nowMs)) {
    const minutes = Math.floor(Math.max(0, nowMs - launched) / 60_000);
    const age = minutes < 1 ? '<1 min' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
    report.push(`- Age: ${age}`);
  }
  const url = typeof detail.publish?.prUrl === 'string' ? safePrUrl(detail.publish.prUrl) : null;
  if (url) report.push(`- PR: ${url}`);

  const tail = detail.log?.tail;
  if (detail.log?.source === 'missing' || !Array.isArray(tail) || tail.length === 0) {
    report.push('', 'No log yet');
  } else {
    const lines = tail.filter((line): line is string => typeof line === 'string').flatMap(line => clean(line).split('\n'));
    const limit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : 60;
    const selected = limit === 0 ? [] : lines.slice(-limit);
    let backticks = 3;
    for (const line of selected) for (const match of line.matchAll(/`+/g)) backticks = Math.max(backticks, match[0].length + 1);
    const fence = '`'.repeat(backticks);
    report.push('', `${fence}text`, ...selected, fence);
    if (lines.length > selected.length) report.push('(log truncated)');
  }
  if (detail.log?.truncated === true && report[report.length - 1] !== '(log truncated)') report.push('(log truncated)');
  return report.join('\n');
}
