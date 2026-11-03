/** `ashlr fleet reassign-stdin` — RQ-PHX-REASSIGNSTDIN02SOMU1: move an explicit
 * set of queued jobs to one lane. Stdin carries one RQ-PHX id per line; every
 * id is handed, in order, to the single-job reassignQueuedJobs core, so the
 * verified write, held-lane, launched-job and audit-log rules are the core's
 * own. This verb adds no queue writer and never sets force.
 *
 * ALL-OR-NOTHING ONLY AT INPUT. stdin is read to end-of-input and validated
 * (ids, count, size, encoding, timeout) before the first mutation. After that
 * the batch is NOT atomic: each id is written and verified on its own, a
 * refusal or failure on one id does not stop the rest, and nothing is rolled
 * back. The aggregate says exactly which ids moved, which were refused and
 * which failed.
 *
 *   printf 'RQ-PHX-FAKEONE01\nRQ-PHX-FAKETWO02\n' | ashlr fleet reassign-stdin --lane devin --apply
 */
import { type Readable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { makeColors, isTty } from './ui.js';
import { formatReassignReport } from './fleet-reassign.js';
import { reassignQueuedJobs, ReassignError, type ReassignInput, type ReassignOptions, type ReassignReportV1 } from '../core/fleet/runs-reassign.js';

const { red } = makeColors(isTty());
const VERB = 'ashlr fleet reassign-stdin';
const USAGE = 'usage: ashlr fleet reassign-stdin --lane <lane> [--tier <tier>] [--apply] [--reason <text>] [--runs-dir <abs>] [--json] < ids.txt\n' +
  'Reads one RQ-PHX job id per nonempty line on stdin (max 100 unique ids, 32 KiB). Duplicate ids run once, in first-seen order.\n' +
  'Dry run by default; --apply moves each id through the single-job reassign core, one id at a time.\n' +
  'PARTIAL APPLICATION: NOT atomic. Each id is written and verified separately. A refused or failed id does not stop later ids,\n' +
  'and an id already moved is not rolled back. Read the per-id report for what actually moved.\n' +
  'Input must be piped (not a TTY) and reach end-of-input within 5000 ms; malformed, oversize or unterminated input moves nothing.\n' +
  'Exit: 0 when no id failed (refusals such as lane-held or job-launched are reported per id and exit 0); 1 when an id failed\n' +
  '(queue-missing, unexpected) or an applied write could not be verified; 2 on bad arguments or input.';

const MAX_IDS = 100;
const MAX_INPUT_BYTES = 32 * 1024;
const DEFAULT_INPUT_TIMEOUT_MS = 5000;
const JOB_ID_RE = /^RQ-PHX-[A-Z0-9]{3,40}$/;
const VALUE_FLAGS = new Set(['--lane', '--tier', '--reason', '--runs-dir']);
const BOOL_FLAGS = new Set(['--apply', '--json']);
/** Codes that mean the batch could not do what was asked, not a plain refusal. */
const FAILURE_CODES = new Set(['unverified', 'unexpected', 'queue-missing']);
const INPUT_MESSAGE = {
  'stdin-tty': 'stdin must be piped; interactive input is refused',
  'oversize': `input exceeds ${MAX_INPUT_BYTES} bytes`,
  'input-timeout': 'input did not reach end-of-input in time (unterminated)',
  'read-failed': 'stdin could not be read',
} as const;

export interface StdinReassignDeps {
  /** Injected readable for tests; defaults to process.stdin. */
  input?: Readable & { isTTY?: boolean };
  /** Injected per-id core call; defaults to reassignQueuedJobs. Tests wrap it to shrink verifyMs. */
  reassign?: (input: ReassignInput, opts: ReassignOptions) => Promise<ReassignReportV1>;
  /** Finite stdin deadline; defaults to 5000 ms. */
  inputTimeoutMs?: number;
}

export interface StdinReassignError { id: string; code: string; message: string }
export interface StdinReassignAggregateV1 {
  v: 1;
  applied: boolean;
  lane: string;
  tier: string | null;
  requested: number;
  reports: ReassignReportV1[];
  errors: StdinReassignError[];
}

const fail = (message: string): number => {
  process.stderr.write(red('error: ') + `fleet reassign-stdin: ${message}\n${USAGE}\n`);
  return 2;
};

interface ParsedArgs { lane: string; tier?: string; reason?: string; runsDir?: string; apply: boolean; json: boolean }

function parseArgs(args: readonly string[]): ParsedArgs | string {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (BOOL_FLAGS.has(token)) {
      if (flags.has(token)) return `duplicate flag ${token}`;
      flags.add(token);
    } else if (VALUE_FLAGS.has(token)) {
      if (values.has(token)) return `duplicate flag ${token}`;
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${token} requires a value`;
      values.set(token, value);
      i++;
    } else {
      return `unexpected argument ${token}`;
    }
  }
  const lane = values.get('--lane');
  const runsDir = values.get('--runs-dir');
  if (!lane) return '--lane is required';
  if (runsDir !== undefined && !isAbsolute(runsDir)) return '--runs-dir requires an absolute path';
  const tier = values.get('--tier');
  const reason = values.get('--reason');
  return {
    lane,
    apply: flags.has('--apply'),
    json: flags.has('--json'),
    ...(tier !== undefined ? { tier } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(runsDir !== undefined ? { runsDir } : {}),
  };
}

/**
 * Collect stdin bytes up to MAX_INPUT_BYTES, or give up on a stall. Every
 * listener is removed and the stream paused on every exit path, so a refused
 * or expired read leaves nothing attached to the process.
 */
function readInput(input: Readable & { isTTY?: boolean }, timeoutMs: number): Promise<Buffer | keyof typeof INPUT_MESSAGE> {
  if (input.isTTY) return Promise.resolve('stdin-tty');
  if (input.destroyed || input.readableEnded) return Promise.resolve('read-failed');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (result: Buffer | keyof typeof INPUT_MESSAGE): void => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onFailure);
      input.removeListener('close', onFailure);
      input.pause();
      resolve(result);
    };
    const onFailure = (): void => finish('read-failed');
    const onEnd = (): void => finish(Buffer.concat(chunks, size));
    const onData = (chunk: unknown): void => {
      if (!(chunk instanceof Uint8Array)) return finish('read-failed');
      size += chunk.byteLength;
      if (size > MAX_INPUT_BYTES) return finish('oversize');
      chunks.push(Buffer.from(chunk));
    };
    const timer = setTimeout(() => finish('input-timeout'), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onFailure);
    input.once('close', onFailure);
  });
}

/** One id per nonempty line, deduplicated in first-seen order; a bad line refuses the whole batch. */
function parseIds(bytes: Buffer): string[] | string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return 'input must be UTF-8'; }
  const ids = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i]!.trim();
    if (!id) continue;
    if (!JOB_ID_RE.test(id)) return `line ${i + 1} is not an RQ-PHX job id`;
    ids.add(id);
    if (ids.size > MAX_IDS) return `more than ${MAX_IDS} unique job ids`;
  }
  return ids.size === 0 ? 'no job ids on stdin' : [...ids];
}

function humanOutput(aggregate: StdinReassignAggregateV1): string {
  const lines = aggregate.reports.map(formatReassignReport);
  for (const error of aggregate.errors) {
    lines.push(`${FAILURE_CODES.has(error.code) ? 'failed' : 'refused'} ${error.id}  ${error.code}: ${error.message}`);
  }
  return lines.join('\n');
}

/** Convention loader entry. Input and the per-id core are injectable; programmatic only. */
export async function cmdFleetReassignStdin(args: string[], deps: StdinReassignDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') return fail(parsed);

  const bytes = await readInput(deps.input ?? process.stdin, deps.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS);
  if (typeof bytes === 'string') return fail(INPUT_MESSAGE[bytes]);
  const ids = parseIds(bytes);
  if (typeof ids === 'string') return fail(ids);

  const reassign = deps.reassign ?? reassignQueuedJobs;
  const reports: ReassignReportV1[] = [];
  const errors: StdinReassignError[] = [];
  for (const id of ids) {
    try {
      const report = await reassign({
        job: id,
        lane: parsed.lane,
        apply: parsed.apply,
        ...(parsed.tier !== undefined ? { tier: parsed.tier } : {}),
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      }, { ...(parsed.runsDir !== undefined ? { runsDir: parsed.runsDir } : {}), changedBy: VERB });
      reports.push(report);
      if (report.applied && report.verified === false) {
        errors.push({ id, code: 'unverified', message: 'the dispatcher rewrote ready.tsv under the move; not confirmed, re-run to retry' });
      }
    } catch (error) {
      errors.push(error instanceof ReassignError
        ? { id, code: error.code, message: error.message }
        : { id, code: 'unexpected', message: 'reassign failed' });
    }
  }

  const aggregate: StdinReassignAggregateV1 = {
    v: 1,
    applied: parsed.apply,
    lane: parsed.lane,
    tier: parsed.tier ?? null,
    requested: ids.length,
    reports,
    errors,
  };
  console.log(parsed.json ? JSON.stringify(aggregate) : humanOutput(aggregate));
  return errors.some((error) => FAILURE_CODES.has(error.code)) ? 1 : 0;
}
