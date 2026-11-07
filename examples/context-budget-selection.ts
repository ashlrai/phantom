#!/usr/bin/env -S npx tsx
/**
 * Select a context pack before handing work to an agent; this example never dispatches.
 * Run: npx tsx examples/context-budget-selection.ts --file snapshot.json --budgets 128,512,4096
 * The snapshot has the node_context_pack shape, including a valid byteBudget;
 * the ascending budget list overrides that field for each attempt. stdout is one JSON object.
 */
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNodeContextPack, type NodeContextRecord } from '../src/core/fleet/node-context-pack.js';
import { summarizeNodeContextCoverage } from '../src/core/fleet/node-context-coverage.js';
import { readNodeContextCitations } from '../src/core/fleet/node-context-citations.js';
import { readStableRegularFile } from '../src/core/util/stable-file-read.js';
import { MAX_CONTEXT_PACK_BUDGET, parseContextPackArguments } from '../src/mcp/context-server.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_BUDGETS = 16;
const USAGE = 'Use --file SNAPSHOT --budgets N[,N...] (strictly ascending).';

/** Read one bounded snapshot and return an exit code; no dispatch or process exit. */
export function main(args: readonly string[]): number {
  const emit = (value: object, code: number): number => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return code;
  };
  const fail = (code: string, message: string, exit = 2): number =>
    emit({ schemaVersion: 1, status: 'error', error: { code, message } }, exit);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return emit({ schemaVersion: 1, usage: USAGE }, 0);
  }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--file', '--budgets'].includes(key) || value === undefined || values.has(key)) {
      return fail('INVALID_ARGUMENTS', USAGE);
    }
    values.set(key, value);
  }
  const file = values.get('--file');
  const parts = values.get('--budgets')?.split(',') ?? [];
  if (!file?.trim() || file.startsWith('-') || file.includes('\0') || parts.length === 0 ||
      parts.length > MAX_BUDGETS || !parts.every(part => /^[1-9][0-9]*$/.test(part) &&
        Number.isSafeInteger(Number(part)) && Number(part) <= MAX_CONTEXT_PACK_BUDGET)) {
    return fail('INVALID_ARGUMENTS', USAGE);
  }
  const budgets = parts.map(Number);
  if (budgets.some((budget, i) => i > 0 && budget <= budgets[i - 1]!)) {
    return fail('INVALID_ARGUMENTS', USAGE);
  }

  let raw: unknown;
  try {
    const absolute = resolve(file);
    const read = readStableRegularFile(absolute, {
      anchorPath: dirname(absolute), maxFileBytes: MAX_SNAPSHOT_BYTES, remainingBytes: MAX_SNAPSHOT_BYTES,
    });
    if (!read.ok) {
      const invalid = ['unsafe-file', 'unsafe-path', 'per-file-byte-limit', 'byte-limit'].includes(read.reason);
      return fail('SNAPSHOT_UNAVAILABLE', 'Snapshot could not be read safely.', invalid ? 2 : 1);
    }
    try { raw = JSON.parse(read.text) as unknown; }
    catch { return fail('INVALID_SNAPSHOT', 'Snapshot must be valid JSON.'); }
  } catch {
    return fail('SNAPSHOT_UNAVAILABLE', 'Snapshot could not be read safely.', 1);
  }

  let snapshot: ReturnType<typeof parseContextPackArguments>;
  try {
    snapshot = parseContextPackArguments(raw);
    const original = raw as { node: { jobId: string; upstreamJobIds: string[] };
      tasks: NodeContextRecord[]; outputs: NodeContextRecord[] };
    // A scrubbed identity must not silently merge distinct jobs or remove a requirement.
    const validId = (before: string, after: string): boolean => before.trim().length > 0 && before === after;
    if (!validId(original.node.jobId, snapshot.node.jobId) ||
        snapshot.node.upstreamJobIds.some((id, i) => !validId(original.node.upstreamJobIds[i]!, id)) ||
        snapshot.tasks.some((row, i) => !validId(original.tasks[i]!.jobId, row.jobId)) ||
        snapshot.outputs.some((row, i) => !validId(original.outputs[i]!.jobId, row.jobId)) ||
        snapshot.node.upstreamJobIds.includes(snapshot.node.jobId)) throw new Error();
  } catch {
    return fail('INVALID_SNAPSHOT', 'Snapshot has an invalid shape, bounds, or identity.');
  }

  const required = new Set(snapshot.node.upstreamJobIds);
  const attempts = [];
  for (const budget of budgets) {
    const input = { ...snapshot, byteBudget: budget };
    const pack = buildNodeContextPack(input);
    const coverage = summarizeNodeContextCoverage(input, pack).upstream;
    const citations = readNodeContextCitations(pack);
    const complete = new Set(pack.split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line) as { jobId: string; kind: string; text: string; truncated: boolean };
      return row.kind === 'output' && !row.truncated ? JSON.stringify([row.jobId, row.text]) : '';
    }));
    // Coverage is per job and can be included if just one of several outputs fits.
    const incompleteOutputJobIds = [...new Set(snapshot.outputs.filter(row => required.has(row.jobId) &&
      row.text.trim() && !complete.has(JSON.stringify([row.jobId, row.text]))).map(row => row.jobId))];
    const attempt = { budget, bytes: Buffer.byteLength(pack, 'utf8'), coverage, citations, incompleteOutputJobIds };
    attempts.push(attempt);
    if (coverage.every(row => row.state === 'included') && incompleteOutputJobIds.length === 0) {
      return emit({ schemaVersion: 1, status: 'ready', jobId: snapshot.node.jobId,
        chosenBudget: budget, pack, bytes: attempt.bytes, citations, attempts }, 0);
    }
  }
  return emit({ schemaVersion: 1, status: 'insufficient', jobId: snapshot.node.jobId, attempts }, 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
