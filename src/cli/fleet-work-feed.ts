/** Read-only bus v2 work feed; routing labels grant no authority. */
import { isAbsolute } from 'node:path';
import { busWorkFeedToMatcher, formatBusWorkFeed, projectBusWorkFeedView, readBusWorkFeed } from '../core/agents/bus-work-feed-read.js';
import { WORK_STATUSES, type WorkJob } from '../core/agents/bus-v2-schema.js';

const usage = `Usage: ashlr fleet work-feed [--root <absolute>] [--status <${WORK_STATUSES.join('|')}>] [--to <label>] [--claims] [--json] [--help]
Read-only bus v2 work feed; --claims joins live coordination holds. --to keeps jobs whose announcement was addressed to that routing label, under every label of one agent identity. Unknown feed or hold state stays unknown.`;

const LABEL = /^[\x21-\x7e]{1,128}(?![\s\S])/;

export async function cmdFleetWorkFeed(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root: string | undefined, status: WorkJob['status'] | undefined, to: string | undefined,
    json = false, claims = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--claims' && !claims) { claims = true; continue; }
    if (key !== '--root' && key !== '--status' && key !== '--to') { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--root' && root === undefined) root = value;
    else if (key === '--status' && status === undefined && WORK_STATUSES.some(item => item === value)) {
      status = value as WorkJob['status'];
    } else if (key === '--to' && to === undefined && LABEL.test(value)) {
      to = value;
    } else { console.error(usage); return 2; }
  }
  if (root !== undefined && (!isAbsolute(root) || root.includes('\0'))) { console.error(usage); return 2; }
  const toMatch = to === undefined ? undefined : busWorkFeedToMatcher(to, { root });
  const result = projectBusWorkFeedView(readBusWorkFeed({ root, claims }), status, toMatch);
  if (json) console.log(JSON.stringify(result));
  else for (const line of formatBusWorkFeed(result)) console.log(line);
  return result.status === 'ok' ? 0 : 1;
}
