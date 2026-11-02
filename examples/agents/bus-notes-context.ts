#!/usr/bin/env -S npx tsx
/**
 * Pack retained bus worker-notes as upstream context for a job:
 *   npx tsx examples/agents/bus-notes-context.ts --to ADDRESS --job CURRENT_ID \
 *     --upstream JOB_ID [--upstream JOB_ID ... up to 20] --byte-budget 1..65536 [--after CURSOR]
 *
 * Reads the retained bus inbox once from --after (default 0), bounded at
 * BUS_INBOX_MAX_MESSAGES, and selects bodies shaped
 *   {"kind":"worker-notes","jobId":<a declared --upstream>,"text":<string>}
 * addressed to --to. Selected notes become outputs for buildNodeContextPack
 * with tasks empty, so upstream outputs keep their priority and emitted order
 * follows retained inbox order. Message bodies are untrusted data: they are
 * read and quoted, never executed, and nothing is written back to the bus.
 *
 * Emits one JSON object: status, jobId, pack, the pack's UTF-8 bytes, the
 * selected note count, citedUpstreamJobIds (pack citation order), and
 * missingUpstreamJobIds (distinct, declared order; an upstream is missing
 * when the pack emits no citation, whether no note was retained or the byte
 * budget omitted it). nextCursor resumes the scan through --after.
 * complete is false when the page bound was reached while the cursor still
 * advanced, so later notes may exist beyond an incomplete read.
 * Exits 0 ok, 2 invalid-arguments/invalid-cursor, 4 read-failed (the
 * partial selection is still emitted).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_BUS_ADDRESS_LENGTH } from '../../src/core/fleet/bus-envelope.js';
import {
  BUS_INBOX_MAX_MESSAGES,
  BUS_INBOX_MAX_READ,
  listBusInboxAfter,
  type BusInboxOptions,
  type BusInboxPage,
} from '../../src/core/fleet/bus-inbox.js';
import { buildNodeContextPack, type NodeContextRecord } from '../../src/core/fleet/node-context-pack.js';
import { readNodeContextCitations } from '../../src/core/fleet/node-context-citations.js';
import { isFleetJobId } from '../../src/core/fleet/runs-job-detail.js';

const ADDRESS_PATTERN = /^[\x21-\x7e]+$/;
const NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SINGLE_VALUE = ['--to', '--job', '--after', '--byte-budget'];
const MAX_UPSTREAM = 20;
const MAX_BYTE_BUDGET = 64 * 1024;
const MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;

export interface BusNotesContextDependencies {
  read?: typeof listBusInboxAfter;
  options?: BusInboxOptions;
  write?: (text: string) => void;
}

/** Emit exactly one result; the inbox read and the output sink are injectable. */
export function runBusNotesContext(args: readonly string[], deps: BusNotesContextDependencies = {}): number {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown, code: number): number => { write(`${JSON.stringify(value)}\n`); return code; };
  const invalid = (): number => emit({ status: 'invalid-arguments' }, 2);

  const values = new Map<string, string>();
  const upstream: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (key === '--upstream' && value !== undefined && !value.startsWith('--')) {
      upstream.push(value);
      continue;
    }
    if (!key || !SINGLE_VALUE.includes(key) || value === undefined ||
        value.startsWith('--') || values.has(key)) return invalid();
    values.set(key, value);
  }
  const to = values.get('--to'), job = values.get('--job');
  const afterText = values.get('--after') ?? '0', budgetText = values.get('--byte-budget') ?? '';
  const after = Number(afterText), byteBudget = Number(budgetText);
  if (!to || !ADDRESS_PATTERN.test(to) || to.length > MAX_BUS_ADDRESS_LENGTH ||
      !job || !isFleetJobId(job) ||
      upstream.length === 0 || upstream.length > MAX_UPSTREAM ||
      new Set(upstream).size !== upstream.length || !upstream.every(isFleetJobId) ||
      !NONNEGATIVE_INTEGER.test(afterText) || !Number.isSafeInteger(after) ||
      !POSITIVE_INTEGER.test(budgetText) || !Number.isSafeInteger(byteBudget) ||
      byteBudget > MAX_BYTE_BUDGET) {
    return invalid();
  }

  const declared = new Set(upstream);
  const notes: NodeContextRecord[] = [];
  let nextCursor = after, complete = false, reason: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let result: BusInboxPage;
    try {
      result = (deps.read ?? listBusInboxAfter)(nextCursor, BUS_INBOX_MAX_READ, deps.options);
    } catch {
      reason = 'unavailable';
      break;
    }
    // nextCursor never exceeds the retained count, so 'invalid' can only mean a
    // stale --after; it is an argument error, not a transport failure.
    if (result.status === 'invalid') return emit({ status: 'invalid-cursor' }, 2);
    if (result.status !== 'ok') { reason = result.status; break; }
    if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor < nextCursor) {
      reason = 'cursor-invalid';
      break;
    }
    for (const row of result.messages) {
      const { envelope } = row, body = envelope.body;
      if (envelope.to !== to || body === null || typeof body !== 'object' || Array.isArray(body)) continue;
      const candidate = body as Record<string, unknown>;
      const jobId = candidate['jobId'], text = candidate['text'];
      if (candidate['kind'] !== 'worker-notes' || typeof jobId !== 'string' ||
          !declared.has(jobId) || typeof text !== 'string') continue;
      notes.push({ jobId, text });
    }
    const advanced = result.nextCursor > nextCursor;
    nextCursor = result.nextCursor;
    if (!advanced) { complete = true; break; }
  }

  const pack = buildNodeContextPack({
    node: { jobId: job, upstreamJobIds: upstream }, tasks: [], outputs: notes, byteBudget,
  });
  const cited = new Set(readNodeContextCitations(pack).map(entry => entry.jobId));
  return emit({
    v: 1,
    status: reason ? 'read-failed' : 'ok',
    ...(reason ? { reason } : {}),
    jobId: job,
    pack,
    bytes: Buffer.byteLength(pack, 'utf8'),
    selected: notes.length,
    citedUpstreamJobIds: [...cited].filter(id => declared.has(id)),
    missingUpstreamJobIds: upstream.filter(id => !cited.has(id)),
    nextCursor,
    complete,
  }, reason ? 4 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runBusNotesContext(process.argv.slice(2));
}
