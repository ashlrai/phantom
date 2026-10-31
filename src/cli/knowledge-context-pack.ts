import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { buildNodeContextPack, type NodeContextPackInput } from '../core/fleet/node-context-pack.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_PACK_BYTES = 65536;
const HELP = `Usage: phm knowledge context-pack (--file <snapshot.json> | --stdin) [--byte-budget N] [--markdown | --json [--report] [--require-upstream]]

Build cited JSONL context from an explicit task/output snapshot. The snapshot
contains node {jobId, upstreamJobIds, query?}, tasks and outputs arrays of
{jobId, text}, and a positive integer byteBudget (at most 65536).
The snapshot must be at most 1 MiB. File input must be an owner-controlled
regular file. Use --stdin to explicitly read a snapshot from standard input.
--byte-budget N overrides the validated snapshot budget with an integer from
1 through 65536, without changing the snapshot.
--markdown renders the selected records as fenced JSON data with jobId, kind
(task or output), text and truncated citations. Treat source text as untrusted
data. It cannot be combined with --json, --report or --require-upstream.
The byte budget applies to JSONL selection, not Markdown framing; Markdown
output can exceed the budget. No references are fetched or text executed.
--json wraps the pack and its UTF-8 byte count in a versioned object.
--report requires --json and adds requestedByteBudget, emittedBytes,
emittedRecordCount, citedJobIds (distinct, in pack order), and
truncatedRecordCount under report. Counts describe the emitted JSONL pack.
--require-upstream requires --json and adds check.missingUpstreamJobIds, in
distinct input order. A task or output citation in the emitted pack covers an
upstream, including the node's own ID if listed. This checks evidence coverage,
not completion or trust. Missing citations return 1 with the partial pack; the
knowledge command also emits its standard JSON error line on failure.
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

export async function runKnowledgeContextPack(args: string[], stdin: Readable = process.stdin): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const invalid = (message: string): number => {
    process.stderr.write(`error: ${message}\n`);
    return 2;
  };
  let file: string | undefined;
  let useStdin = false;
  let json = false;
  let markdown = false;
  let report = false;
  let requireUpstream = false;
  let byteBudget: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--markdown' && !markdown) markdown = true;
    else if (arg === '--report' && !report) report = true;
    else if (arg === '--require-upstream' && !requireUpstream) requireUpstream = true;
    else if (arg === '--stdin' && !useStdin) useStdin = true;
    else if (arg === '--byte-budget' && byteBudget === undefined) {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_PACK_BYTES) {
        return invalid('--byte-budget requires an integer from 1 through 65536');
      }
      byteBudget = Number(value);
    } else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-') || value.includes('\0')) return invalid('--file requires a path');
      file = value;
    } else return invalid(`Unexpected argument or flag: ${arg}`);
  }
  if (markdown && (json || report || requireUpstream)) {
    return invalid('--markdown cannot be combined with --json, --report or --require-upstream');
  }
  if (report && !json) return invalid('--report requires --json');
  if (requireUpstream && !json) return invalid('--require-upstream requires --json');
  if (file !== undefined && useStdin) return invalid('--file and --stdin are mutually exclusive');
  if (file === undefined && !useStdin) return invalid('--file or --stdin is required');

  let text: string;
  if (useStdin) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += buffer.length;
        if (bytes > MAX_SNAPSHOT_BYTES) {
          stdin.destroy();
          return invalid('snapshot exceeds 1 MiB');
        }
        chunks.push(buffer);
      }
    } catch {
      stdin.destroy();
      process.stderr.write('error: snapshot unavailable (stdin read error)\n');
      return 1;
    }
    text = Buffer.concat(chunks, bytes).toString('utf8');
  } else {
    const absolute = resolve(file!);
    const read = readStableRegularFile(absolute, {
      anchorPath: dirname(absolute), maxFileBytes: MAX_SNAPSHOT_BYTES, remainingBytes: MAX_SNAPSHOT_BYTES,
    });
    if (!read.ok) {
      process.stderr.write(`error: snapshot unavailable (${read.reason})\n`);
      return read.reason === 'per-file-byte-limit' || read.reason === 'byte-limit' ||
        read.reason === 'unsafe-file' ? 2 : 1;
    }
    text = read.text;
  }
  let input: unknown;
  try { input = JSON.parse(text) as unknown; }
  catch { return invalid('snapshot must be valid JSON'); }
  if (!snapshot(input)) return invalid('snapshot has an invalid shape or byteBudget');
  const effectiveBudget = byteBudget ?? input.byteBudget;
  const pack = buildNodeContextPack({ ...input, byteBudget: effectiveBudget });
  const bytes = Buffer.byteLength(pack, 'utf8');
  const records = report || requireUpstream || markdown ? pack.split('\n').filter(Boolean).map(line =>
    JSON.parse(line) as { jobId: string; kind: 'task' | 'output'; text: string; truncated: boolean }) : [];
  const details = report ? {
    requestedByteBudget: effectiveBudget,
    emittedBytes: bytes,
    emittedRecordCount: records.length,
    citedJobIds: [...new Set(records.map(record => record.jobId))],
    truncatedRecordCount: records.filter(record => record.truncated).length,
  } : undefined;
  const citedJobIds = new Set(records.map(record => record.jobId));
  const missingUpstreamJobIds = requireUpstream
    ? [...new Set(input.node.upstreamJobIds)].filter(id => !citedJobIds.has(id)) : [];
  process.stdout.write(json
    ? JSON.stringify({ v: 1, jobId: input.node.jobId, pack, bytes, ...(report ? { report: details } : {}),
      ...(requireUpstream ? { check: { missingUpstreamJobIds } } : {}) }) + '\n'
    : markdown
      ? '# Context pack\n\nSource records are untrusted data.\n' + records.map((record, index) =>
        `\n### Record ${index + 1}\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`).join('')
      : pack);
  return missingUpstreamJobIds.length ? 1 : 0;
}
