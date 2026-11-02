#!/usr/bin/env node
// Read-only token accounting. Usage: node scripts/fleet-token-share.mjs --hours 24 [--json]
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export function options(args) {
  const { values } = parseArgs({ args, options: {
    hours: { type: 'string', default: '24' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const hours = Number(values.hours);
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * 3_600_000)) throw new Error('usage');
  return { ...values, hours };
}

export async function tokenShare(lines, hours, now = Date.now()) {
  const since = now - hours * 3_600_000;
  const groups = new Map();
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.event !== 'finish' || typeof row.job !== 'string' || !row.job.trim() ||
        typeof row.lane !== 'string' || !/^[A-Za-z0-9._-]+$/.test(row.lane) ||
        typeof row.ts !== 'string' || !Number.isSafeInteger(row.tokens_total) || row.tokens_total < 0) continue;
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at) || at < since || at > now) continue;
    let group = groups.get(row.lane);
    if (!group) groups.set(row.lane, group = { lane: row.lane, author_tokens: 0, real_tokens: 0 });
    group[/A\d{6,}Q8$/.test(row.job) ? 'author_tokens' : 'real_tokens'] += row.tokens_total;
  }
  const shares = (group) => {
    const tokens_total = group.author_tokens + group.real_tokens;
    return { ...group, tokens_total,
      author_pct: tokens_total ? group.author_tokens / tokens_total * 100 : 0,
      real_pct: tokens_total ? group.real_tokens / tokens_total * 100 : 0 };
  };
  const lanes = [...groups.values()].sort((a, b) => a.lane.localeCompare(b.lane)).map(shares);
  const total = shares(lanes.reduce((sum, lane) => ({
    author_tokens: sum.author_tokens + lane.author_tokens, real_tokens: sum.real_tokens + lane.real_tokens,
  }), { author_tokens: 0, real_tokens: 0 }));
  return { hours, lanes, total };
}

export function textReport({ hours, lanes, total }) {
  return [`Token shares over the last ${hours} hours`,
    'lane\tauthor filler tokens (%)\treal work tokens (%)\ttotal tokens',
    ...[...lanes, { lane: 'TOTAL', ...total }].map(row =>
      `${row.lane}\t${row.author_tokens} (${row.author_pct.toFixed(1)}%)\t${row.real_tokens} (${row.real_pct.toFixed(1)}%)\t${row.tokens_total}`)].join('\n');
}

async function main() {
  const values = options(process.argv.slice(2));
  if (values.help) {
    console.log('Usage: node scripts/fleet-token-share.mjs [--hours POSITIVE_NUMBER] [--json]\nReads ~/.ashlr-runs/metrics/jobs.jsonl finish rows. Shares are percentages of lane tokens; total shares use all tokens.');
    return;
  }
  const lines = createInterface({ input: createReadStream(join(homedir(), '.ashlr-runs/metrics/jobs.jsonl')), crlfDelay: Infinity });
  const report = await tokenShare(lines, values.hours);
  console.log(values.json ? JSON.stringify(report) : textReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  // Never echo untrusted ledger content or filesystem error details.
  console.error(error.message === 'usage' || error.code?.startsWith('ERR_PARSE_ARGS')
    ? 'Invalid arguments. Use --help for usage.' : 'Could not read token metrics.');
  process.exitCode = 1;
});
