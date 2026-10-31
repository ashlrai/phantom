import { dirname, resolve } from 'node:path';
import { buildNodeContextPack, type NodeContextPackInput } from '../core/fleet/node-context-pack.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_PACK_BYTES = 65536;
const HELP = `Usage: phm knowledge context-pack --file <snapshot.json> [--json]

Build cited JSONL context from an explicit task/output snapshot. The snapshot
contains node {jobId, upstreamJobIds, query?}, tasks and outputs arrays of
{jobId, text}, and a positive integer byteBudget (at most 65536).
The snapshot must be an owner-controlled regular file, at most 1 MiB.
--json wraps the pack and its UTF-8 byte count in a versioned object.
`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function snapshot(value: unknown): value is NodeContextPackInput {
  if (!object(value) || !keys(value, ['node', 'tasks', 'outputs', 'byteBudget'])) return false;
  const node = value.node;
  if (!object(node) || !keys(node, ['jobId', 'upstreamJobIds'], ['query']) ||
      typeof node.jobId !== 'string' || !Array.isArray(node.upstreamJobIds) ||
      !node.upstreamJobIds.every(id => typeof id === 'string') ||
      (Object.hasOwn(node, 'query') && typeof node.query !== 'string')) return false;
  const records = (rows: unknown): boolean => Array.isArray(rows) && rows.every(row =>
    object(row) && keys(row, ['jobId', 'text']) && typeof row.jobId === 'string' && typeof row.text === 'string');
  return records(value.tasks) && records(value.outputs) &&
    typeof value.byteBudget === 'number' && Number.isSafeInteger(value.byteBudget) &&
    value.byteBudget > 0 && value.byteBudget <= MAX_PACK_BYTES;
}

export async function runKnowledgeContextPack(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const invalid = (message: string): number => {
    process.stderr.write(`error: ${message}\n`);
    return 2;
  };
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-') || value.includes('\0')) return invalid('--file requires a path');
      file = value;
    } else return invalid(`Unexpected argument or flag: ${arg}`);
  }
  if (file === undefined) return invalid('--file is required');

  const absolute = resolve(file);
  const read = readStableRegularFile(absolute, {
    anchorPath: dirname(absolute), maxFileBytes: MAX_SNAPSHOT_BYTES, remainingBytes: MAX_SNAPSHOT_BYTES,
  });
  if (!read.ok) {
    process.stderr.write(`error: snapshot unavailable (${read.reason})\n`);
    return read.reason === 'per-file-byte-limit' || read.reason === 'byte-limit' ||
      read.reason === 'unsafe-file' ? 2 : 1;
  }
  let input: unknown;
  try { input = JSON.parse(read.text) as unknown; }
  catch { return invalid('snapshot must be valid JSON'); }
  if (!snapshot(input)) return invalid('snapshot has an invalid shape or byteBudget');
  const pack = buildNodeContextPack(input);
  process.stdout.write(json
    ? JSON.stringify({ v: 1, jobId: input.node.jobId, pack, bytes: Buffer.byteLength(pack, 'utf8') }) + '\n'
    : pack);
  return 0;
}
