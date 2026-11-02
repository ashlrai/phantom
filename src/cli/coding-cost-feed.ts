/** Offline JSONL adapter. Does not read keys or contact PostHog. */
import { readFile } from 'node:fs/promises';
import { buildCodingCostFeed } from '../core/observability/coding-cost-feed.js';

try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error('usage');
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(line => line.trim());
  const feed = buildCodingCostFeed(lines.map(line => JSON.parse(line) as unknown));
  process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
} catch {
  // Never echo input rows, paths, parser excerpts or credential-bearing errors.
  process.stderr.write('Coding cost feed failed. Supply one valid spend/merge JSONL file.\n');
  process.exitCode = 1;
}
