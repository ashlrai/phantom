#!/usr/bin/env -S npx tsx
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNodeContextPack, type NodeContextRecord } from '../../src/core/fleet/node-context-pack.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';
import { parseContextPackArguments } from '../../src/mcp/context-server.js';

const MAX_FILE_BYTES = 1024 * 1024;
const usage = 'Usage: npx tsx examples/agents/context-dependency-check.ts --file SNAPSHOT';
type Dependencies = {
  read?: typeof readStableRegularFile;
  write?: (text: string) => void;
};
type Issue = { code: string; jobId: string; kind?: 'task' | 'output'; reason?: 'absent' | 'empty'; count?: number };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Audit caller-supplied context and produce the existing bounded, scrubbed pack. */
export async function runContextDependencyCheck(args: readonly string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: object, exit: number) => { write(`${JSON.stringify(value)}\n`); return exit; };
  const fail = (code: string, message: string, exit: number) =>
    emit({ schemaVersion: 1, status: 'error', error: { code, message } }, exit);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return emit({ schemaVersion: 1, usage }, 0);
  }
  const file = args[1];
  if (args.length !== 2 || args[0] !== '--file' || !file?.trim() || file.startsWith('-') || file.includes('\0')) {
    return fail('USAGE', usage, 2);
  }

  let value: unknown;
  try {
    const absolute = resolve(file);
    const read = (deps.read ?? readStableRegularFile)(absolute, {
      anchorPath: dirname(absolute), maxFileBytes: MAX_FILE_BYTES, remainingBytes: MAX_FILE_BYTES,
    });
    if (!read.ok) {
      const invalid = ['unsafe-file', 'unsafe-path', 'per-file-byte-limit', 'byte-limit'].includes(read.reason);
      return fail(invalid ? 'INVALID_FILE' : 'READ_FAILED', 'Snapshot could not be read safely.', invalid ? 2 : 1);
    }
    if (Buffer.byteLength(read.text, 'utf8') > MAX_FILE_BYTES) return fail('INVALID_FILE', 'Snapshot is too large.', 2);
    try { value = JSON.parse(read.text) as unknown; }
    catch { return fail('INVALID_JSON', 'Snapshot must be valid JSON.', 2); }
  } catch {
    return fail('READ_FAILED', 'Snapshot could not be read safely.', 1);
  }

  try {
    if (!object(value) || !object(value.node) || !Object.hasOwn(value.node, 'upstreamJobIds') ||
        !Object.hasOwn(value, 'tasks') || !Object.hasOwn(value, 'outputs')) throw new Error();
    const upstreamKnown = value.node.upstreamJobIds !== null;
    const tasksKnown = value.tasks !== null;
    const outputsKnown = value.outputs !== null;
    // The canonical parser owns shape, size and scrubbing. Null denotes an unknown source.
    const input = parseContextPackArguments({ ...value,
      node: { ...value.node, upstreamJobIds: upstreamKnown ? value.node.upstreamJobIds : [] },
      tasks: tasksKnown ? value.tasks : [], outputs: outputsKnown ? value.outputs : [],
    });
    const originalNode = value.node as { jobId: string; upstreamJobIds: string[] | null };
    const originalTasks = value.tasks as NodeContextRecord[] | null;
    const originalOutputs = value.outputs as NodeContextRecord[] | null;
    // Scrubbed identities must not silently join otherwise distinct jobs.
    const validId = (raw: string, clean: string) => raw.trim().length > 0 && raw === clean;
    if (!validId(originalNode.jobId, input.node.jobId) ||
        input.node.upstreamJobIds.some((id, i) => !validId(originalNode.upstreamJobIds![i]!, id)) ||
        input.tasks.some((row, i) => !validId(originalTasks![i]!.jobId, row.jobId)) ||
        input.outputs.some((row, i) => !validId(originalOutputs![i]!.jobId, row.jobId))) throw new Error();

    const issues: Issue[] = [];
    const kinds = [ ['task', input.tasks, tasksKnown], ['output', input.outputs, outputsKnown] ] as const;
    for (const [kind, records, known] of kinds) {
      if (!known) continue;
      const counts = new Map<string, number>();
      for (const row of records) counts.set(row.jobId, (counts.get(row.jobId) ?? 0) + 1);
      for (const [jobId, count] of counts) {
        if (count > 1) issues.push({ code: 'duplicate_record', kind, jobId, count });
      }
      for (const jobId of new Set(input.node.upstreamJobIds)) {
        const rows = records.filter(row => row.jobId === jobId);
        if (!rows.some(row => row.text.trim())) {
          issues.push({ code: 'missing_context', kind, jobId, reason: rows.length ? 'empty' : 'absent' });
        }
      }
    }
    if (input.node.upstreamJobIds.includes(input.node.jobId)) {
      issues.push({ code: 'self_dependency', jobId: input.node.jobId });
    }
    const pack = buildNodeContextPack(input);
    const citations = pack.split('\n').filter(Boolean).map(line => JSON.parse(line) as { jobId: string; kind: string });
    const upstream = upstreamKnown ? [...new Set(input.node.upstreamJobIds)].map(jobId => ({
      jobId,
      taskInPack: tasksKnown ? citations.some(row => row.jobId === jobId && row.kind === 'task') : null,
      outputInPack: outputsKnown ? citations.some(row => row.jobId === jobId && row.kind === 'output') : null,
    })) : null;
    const sources = { upstream: upstreamKnown ? 'provided' : 'unknown', tasks: tasksKnown ? 'provided' : 'unknown',
      outputs: outputsKnown ? 'provided' : 'unknown' };
    const status = issues.length ? 'issues' : Object.values(sources).includes('unknown') ? 'unknown' : 'ready';
    return emit({ schemaVersion: 1, status, nodeId: input.node.jobId, sources, issues, upstream,
      pack, packBytes: Buffer.byteLength(pack, 'utf8') }, status === 'ready' ? 0 : 1);
  } catch {
    return fail('INVALID_SNAPSHOT', 'Snapshot has an invalid shape, bounds, or identity.', 2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runContextDependencyCheck(process.argv.slice(2));
}
