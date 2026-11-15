import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildOutcomeMetrics } from '../core/fleet/outcome-metrics.js';
import { suggestOutcomePolicy } from '../core/fleet/policy-suggest.js';
import { renderOutcomeReport } from '../core/fleet/weekly-self-report.js';

const usage = 'Usage: phm fleet metrics <report|suggest|weekly> [--hours <1..2160>] [--jobs <file>] [--json]\nRead-only; weekly defaults to 168 hours, report/suggest to 24. Missing evidence is unknown.';
const MAX_BYTES = 16 * 1024 * 1024;
async function readLedger(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > MAX_BYTES ? null : buffer.subarray(0, length).toString('utf8');
  } catch { return null; }
  finally { await file?.close(); }
}
export interface FleetMetricsDeps { read?: (path: string) => Promise<string | null>; now?: () => number }
export async function cmdFleetMetrics(args: string[], deps: FleetMetricsDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const [verb, ...rest] = args;
  if (!['report', 'suggest', 'weekly'].includes(verb ?? '')) { console.error(usage); return 2; }
  let hours = verb === 'weekly' ? 168 : 24, path = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), json = false;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (seen.has(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--hours' && rest[i + 1]) {
      hours = Number(rest[++i]);
      if (!Number.isFinite(hours) || hours < 1 || hours > 2160) { console.error(usage); return 2; }
    } else if (arg === '--jobs' && rest[i + 1] && !rest[i + 1]!.startsWith('--')) path = rest[++i]!;
    else { console.error(usage); return 2; }
  }
  const text = await (deps.read ?? readLedger)(path);
  const events = text === null ? null : text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  });
  const metrics = buildOutcomeMetrics({ events, nowMs: (deps.now ?? Date.now)(), hours });
  const suggestions = suggestOutcomePolicy(metrics);
  const markdown = renderOutcomeReport(metrics, suggestions, verb === 'weekly' ? 'Weekly fleet self-report' : undefined);
  console.log(json ? JSON.stringify(verb === 'suggest' ? suggestions : verb === 'weekly' ? { metrics, suggestions, markdown } : metrics) : markdown);
  return metrics.sourceState === 'healthy' ? 0 : 1;
}
