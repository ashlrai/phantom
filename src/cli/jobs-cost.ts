/** `phm jobs cost`: what finished jobs cost in tokens, per merged PR. Read-only. */
import { join } from 'node:path';
import { readLedgerLines, type YieldLineReader } from '../core/fleet/ledger-lines.js';
import { buildJobsCost, JOB_COST_SCHEMA, jobsCostLines } from '../core/fleet/job-tokens.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm jobs cost [--since 24h] [--by lane|model] [--metrics <jobs.jsonl>] [--json]';

export async function cmdJobsCost(args: string[], read: YieldLineReader = readLedgerLines, now = Date.now()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}
Finished jobs, merged PRs, tokens per merged PR and measured coverage, by lane (default) or model.
Reads the job metrics file (default: <fleet runs dir>/metrics/jobs.jsonl). A job is measured when its finish row has
tokens_total or its log (<fleet runs dir>/<job>.log) ends with Claude Code's result usage or Codex's "tokens used" line.
A job with no usage is unmeasured and shows as unknown, never zero. coverage is measured / jobs.
JSON is ${JOB_COST_SCHEMA} with version 1: schema, window_hours, by, known, total, rows[{key,jobs,measured,coverage,merged,merged_measured,tokens_total,input_tokens,output_tokens,cache_tokens,cost_usd,tokens_per_merged_pr}].`);
    return 0;
  }
  let hours = 24, json = false, metrics: string | null = null, seenSince = false, by: 'lane' | 'model' | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--by' && by === null) {
      const value = args[++i];
      if (value !== 'lane' && value !== 'model') { console.error(usage); return 2; }
      by = value;
    } else if (arg === '--metrics' && metrics === null) {
      metrics = args[++i] ?? '';
      if (!metrics || metrics.startsWith('-')) { console.error(usage); return 2; }
    } else if (arg === '--since' && !seenSince) {
      seenSince = true;
      const match = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      if (!match) { console.error(usage); return 2; }
      hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
    } else { console.error(usage); return 2; }
  }
  if (!(hours > 0 && hours <= 8760)) { console.error(usage); return 2; }
  const path = metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl');
  const lines: string[] = [];
  let ok = false;
  try { ok = await read(path, line => { lines.push(line); }); } catch { /* unknown below */ }
  const root = metrics ? join(path, '..', '..') : runsRoot();
  const report = { ...await buildJobsCost(ok ? lines : [], root, hours, now, by ?? 'lane'), known: ok };
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : jobsCostLines(report).join('\n'));
  return ok ? 0 : 1;
}
