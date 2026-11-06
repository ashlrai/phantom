import { resolve } from 'node:path';
import { readHarnessDigest } from '../core/learn/harness-digest-reader.js';
import { planHarnessRefresh } from '../core/learn/harness-refresh-plan.js';
import { sanitizeCommandLine } from '../core/verse/shell-integration.js';

const usage = 'Usage: ashlr fleet harness-refresh [--limit N] [--file <digest.md>] [--json]';
const display = (value: string): string => sanitizeCommandLine(value).replace(/\n+/g, ' ');

/** Expose local research candidates without fetching sources or launching jobs. */
export async function cmdFleetHarnessRefresh(args: string[], opts: { now?: () => Date; digestFile?: string } = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  let json = false;
  let limit: number | undefined;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) file = args[++i];
    else if (arg === '--limit' && limit === undefined && /^[1-9]\d*$/.test(args[i + 1] ?? '') && Number(args[i + 1]) <= 50) limit = Number(args[++i]);
    else { console.error(usage); return 2; }
  }
  // The reflect reader takes explicit paths relative to cwd; the checked-in digest is the default here.
  const path = resolve(file ?? opts.digestFile ?? 'docs/research/harness-digest-2026-10-31.md');
  const now = (opts.now ?? (() => new Date()))();
  const digest = readHarnessDigest(path, now);
  if (!digest) {
    console.log(json ? JSON.stringify({ state: 'missing', queue: [] }) : `No harness digest at ${display(path)}.`);
    return 0;
  }
  const queue = planHarnessRefresh(digest, limit ?? 5, now);
  if (json) console.log(JSON.stringify({ state: 'ok', file: path, queue }));
  else if (queue.length === 0) console.log('Harness refresh: nothing due');
  else {
    console.log(`Harness refresh: ${queue.length} of ${digest.sources.length} sources due`);
    for (const entry of queue) console.log(`${entry.reason} ${display(entry.id)} — ${display(entry.title)} (checked ${entry.checkedAt ?? 'never'}) ${display(entry.urls[0] ?? '')}`);
  }
  return 0;
}
