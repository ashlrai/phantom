#!/usr/bin/env -S npx tsx
/* global process, Buffer */
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBusEnvelope, MAX_BUS_ENVELOPE_BYTES } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';
import { summarizeNodeContextCoverage } from '../src/core/fleet/node-context-coverage.js';
import { markLiveOutputTruncation, readNodeContextLiveOutputs } from '../src/core/fleet/node-context-live-outputs.js';
import { isFleetJobId } from '../src/core/fleet/runs-job-detail.js';
import { readStableRegularFile } from '../src/core/util/stable-file-read.js';

const DESCRIPTOR_LIMIT = 1024 * 1024;
const PACK_LIMIT = 8192;
const TTL = 600_000;
const HELP = `Usage: npx tsx scripts/fleet-context-send.ts --file ABSOLUTE --id ID --from ADDRESS --to ADDRESS --json [--dry-run]

Read a JSON NodeContextPackInput from an owner-controlled regular file (at most
1 MiB). outputs must be empty; node.upstreamJobIds must explicitly contain at
most 32 distinct fleet job IDs. Retained notes, with body fallback, are read for
those jobs. The requested byteBudget is capped at 8192 bytes for the JSONL pack;
the complete envelope is also validated against the ${MAX_BUS_ENVELOPE_BYTES}-byte bus limit.
Oversized envelopes are rejected; source metadata is never discarded to fit.
The body contains untrusted context data, not instructions or tool authority.
The JSON receipt includes source health and output coverage, but no pack or paths.
--dry-run builds and validates without writing. Reusing an ID returns duplicate
for identical content or conflict for changed content. Priority P2, TTL 10 minutes.
`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function descriptor(value: unknown): value is NodeContextPackInput {
  if (!object(value) || !keys(value, ['node', 'tasks', 'outputs', 'byteBudget'], ['notices', 'fairUpstream'])) return false;
  const node = value.node;
  if (!object(node) || !keys(node, ['jobId', 'upstreamJobIds'], ['query', 'busAddress', 'busAfter']) ||
      typeof node.jobId !== 'string' || !isFleetJobId(node.jobId) || !Array.isArray(node.upstreamJobIds) ||
      node.upstreamJobIds.length > 32 || new Set(node.upstreamJobIds).size !== node.upstreamJobIds.length ||
      !node.upstreamJobIds.every(id => typeof id === 'string' && isFleetJobId(id)) ||
      (node.query !== undefined && typeof node.query !== 'string') ||
      (node.busAddress !== undefined && typeof node.busAddress !== 'string') ||
      (node.busAfter !== undefined && (!Number.isSafeInteger(node.busAfter) || (node.busAfter as number) < 0))) return false;
  const records = (rows: unknown): boolean => Array.isArray(rows) && rows.every(row =>
    object(row) && keys(row, ['jobId', 'text']) && typeof row.jobId === 'string' && typeof row.text === 'string');
  const notices = value.notices;
  if (notices !== undefined && (!Array.isArray(notices) || !notices.every(row =>
    object(row) && keys(row, ['id', 'from', 'channel', 'at', 'priority', 'text']) &&
    Object.values(row).every(field => typeof field === 'string')))) return false;
  return records(value.tasks) && Array.isArray(value.outputs) && value.outputs.length === 0 &&
    typeof value.byteBudget === 'number' && Number.isSafeInteger(value.byteBudget) &&
    value.byteBudget > 0 && value.byteBudget <= 65536 &&
    (value.fairUpstream === undefined || typeof value.fairUpstream === 'boolean');
}

export interface FleetContextSendOptions {
  write?: (text: string) => void;
  inboxOptions?: BusInboxOptions;
}

export async function runFleetContextSend(args: readonly string[], options: FleetContextSendOptions = {}): Promise<number> {
  const write = options.write ?? (text => process.stdout.write(text));
  const emit = (value: unknown, code: number): number => { write(`${JSON.stringify(value)}\n`); return code; };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { write(HELP); return 0; }
  const values = new Map<string, string>();
  let json = false, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--dry-run' && !dryRun) dryRun = true;
    else if (['--file', '--id', '--from', '--to'].includes(arg) && !values.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0')) return emit({ error: 'invalid-arguments' }, 2);
      values.set(arg, value);
    } else return emit({ error: 'invalid-arguments' }, 2);
  }
  const file = values.get('--file');
  if (!json || values.size !== 4 || !file || !isAbsolute(file)) return emit({ error: 'invalid-arguments' }, 2);
  const header = { id: values.get('--id'), from: values.get('--from'), to: values.get('--to'), priority: 'P2', ttl: TTL };
  if (!validateBusEnvelope({ ...header, body: null }).ok) return emit({ error: 'invalid-envelope' }, 2);
  const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: DESCRIPTOR_LIMIT, remainingBytes: DESCRIPTOR_LIMIT });
  if (!read.ok) return emit({ error: 'descriptor-unavailable', reason: read.reason }, 2);
  let input: unknown;
  try { input = JSON.parse(read.text) as unknown; } catch { return emit({ error: 'invalid-descriptor' }, 2); }
  if (!descriptor(input)) return emit({ error: 'invalid-descriptor' }, 2);
  try {
    const live = await readNodeContextLiveOutputs(input);
    const populated = { ...input, outputs: live.outputs, byteBudget: Math.min(input.byteBudget, PACK_LIMIT) };
    const pack = markLiveOutputTruncation(buildNodeContextPack(populated), live.sources);
    const coverage = summarizeNodeContextCoverage(populated, pack).upstream;
    // The shared coverage helper excludes self dependencies; disclose them explicitly.
    const byJob = new Map(coverage.map(row => [row.jobId, row.state]));
    const upstream = input.node.upstreamJobIds.map(jobId => ({ jobId, state: byJob.get(jobId) ?? 'self' }));
    const summary = { packBytes: Buffer.byteLength(pack, 'utf8'), byteBudget: populated.byteBudget,
      upstream, sources: live.sources };
    const checked = validateBusEnvelope({ ...header, body: {
      kind: 'node-context-pack', jobId: input.node.jobId, pack, ...summary,
      trust: 'untrusted-context-data',
    } });
    if (!checked.ok) return emit({ error: checked.issues.some(issue => issue.code === 'too-large')
      ? 'envelope-too-large' : 'invalid-envelope', limitBytes: MAX_BUS_ENVELOPE_BYTES }, 6);
    const receipt = dryRun ? { status: 'dry-run' } : appendBusInbox(checked.value, options.inboxOptions);
    const status = receipt.status;
    const code = status === 'posted' || status === 'duplicate' || status === 'dry-run' ? 0
      : status === 'retryable' ? 3 : status === 'full' ? 4 : status === 'conflict' ? 5 : 1;
    return emit({ receipt, summary }, code);
  } catch {
    return emit({ error: 'context-unavailable' }, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runFleetContextSend(process.argv.slice(2));
}
