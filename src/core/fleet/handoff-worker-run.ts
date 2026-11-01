import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubPrivateText } from '../util/scrub.js';
import { isFleetJobId } from './runs-job-detail.js';
import { runContextWorker, type ContextWorkerIO } from './context-worker-run.js';
import type { NodeContextPackInput } from './node-context-pack.js';
import { renderHandoff, validateHandoff, type WorkerHandoff } from '../verse/handoff.js';

export const HANDOFF_RUN_FILE_MAX_BYTES = 64 * 1024;
export const HANDOFF_RUN_DEFAULT_BYTE_BUDGET = 16384;
export const HANDOFF_RUN_MAX_BYTE_BUDGET = 65536;
export const HANDOFF_RUN_MAX_UPSTREAM = 32;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));
const address = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
const cursor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Check all shapes before calling the typed handoff helpers. */
function isHandoff(value: unknown): value is WorkerHandoff {
  if (!record(value) || !keys(value, ['id', 'task', 'files', 'constraints', 'check', 'findings']) ||
      typeof value.id !== 'string' || typeof value.task !== 'string' || typeof value.check !== 'string' ||
      !Array.isArray(value.files) || !Array.isArray(value.constraints)) return false;
  if (!value.files.every((file: unknown) => {
    if (!record(file) || !keys(file, ['path', 'lines', 'why']) || typeof file.path !== 'string' ||
        (file.why !== undefined && typeof file.why !== 'string')) return false;
    return file.lines === undefined || (record(file.lines) && keys(file.lines, ['from', 'to']) &&
      typeof file.lines.from === 'number' && typeof file.lines.to === 'number');
  })) return false;
  if (!value.constraints.every((item: unknown) => record(item) && keys(item, ['rule', 'reason']) &&
      typeof item.rule === 'string' && typeof item.reason === 'string')) return false;
  return value.findings === undefined || (Array.isArray(value.findings) &&
    value.findings.every((finding: unknown) => typeof finding === 'string'));
}

export interface HandoffWorkerRunOptions {
  /** Absolute path to the handoff JSON. */
  file: string;
  /** Retained-note sources cited into the pack; validated with isFleetJobId. */
  upstreamJobIds: readonly string[];
  busAddress?: string;
  busAfter?: number;
  /** Context pack byte cap, 1..65536; default 16384. */
  byteBudget?: number;
  /** Explicit worker argv; nothing is ever derived from handoff or retained text. */
  argv: readonly string[];
}

/**
 * Run a worker directly from a structured handoff: validate the handoff,
 * render its prompt, pair it with a snapshot the runner can verify, and hand
 * both to runContextWorker through private temporary files. The handoff check,
 * paths, findings, upstream notes and bus bodies are cited context only — they
 * never influence the argv boundary.
 */
export async function runHandoffWorker(opts: HandoffWorkerRunOptions, io: ContextWorkerIO = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const diagnostic = (text: string): void => { stderr.write(`handoff-run: ${text}\n`); };
  const upstream = opts.upstreamJobIds;
  const byteBudget = opts.byteBudget ?? HANDOFF_RUN_DEFAULT_BYTE_BUDGET;
  if (!isAbsolute(opts.file) || opts.file.includes('\0') ||
      !opts.argv.length || opts.argv.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0')) ||
      upstream.length > HANDOFF_RUN_MAX_UPSTREAM || new Set(upstream).size !== upstream.length ||
      !upstream.every(id => typeof id === 'string' && isFleetJobId(id)) ||
      (opts.busAddress !== undefined && !address(opts.busAddress)) ||
      (opts.busAfter !== undefined && !cursor(opts.busAfter)) ||
      (opts.busAfter !== undefined && opts.busAddress === undefined) ||
      !Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > HANDOFF_RUN_MAX_BYTE_BUDGET) {
    diagnostic('invalid input');
    return 2;
  }

  const read = readStableRegularFile(opts.file, {
    anchorPath: dirname(opts.file),
    maxFileBytes: HANDOFF_RUN_FILE_MAX_BYTES,
    remainingBytes: HANDOFF_RUN_FILE_MAX_BYTES,
  });
  if (!read.ok) { diagnostic(`unreadable handoff (${read.reason})`); return 1; }
  let input: unknown;
  try { input = JSON.parse(read.text) as unknown; }
  catch { diagnostic('handoff is not valid JSON'); return 1; }
  if (!isHandoff(input)) { diagnostic('invalid handoff shape'); return 1; }
  const problems = validateHandoff(input);
  if (problems.length) {
    for (const problem of problems.slice(0, 5)) {
      diagnostic(`invalid handoff: ${scrubPrivateText(`${problem.field}: ${problem.detail}`)}`);
    }
    if (problems.length > 5) diagnostic(`invalid handoff: ${problems.length - 5} more problem(s)`);
    return 1;
  }
  // The id becomes NodeContextPackInput.node.jobId, so it must be a real fleet job id.
  if (!isFleetJobId(input.id)) { diagnostic('handoff id is not a fleet job id'); return 1; }

  const snapshot: NodeContextPackInput = {
    node: {
      jobId: input.id,
      upstreamJobIds: [...upstream],
      ...(opts.busAddress !== undefined ? { busAddress: opts.busAddress } : {}),
      ...(opts.busAfter !== undefined ? { busAfter: opts.busAfter } : {}),
    },
    tasks: [{ jobId: input.id, text: input.task }],
    outputs: [],
    byteBudget,
    fairUpstream: true,
  };
  const dir = await mkdtemp(join(resolve(tmpdir()), 'phm-handoff-run-')).catch(() => '');
  if (!dir) { diagnostic('temporary workspace unavailable'); return 1; }
  try {
    const snapshotPath = join(dir, 'snapshot.json');
    const promptPath = join(dir, 'prompt.txt');
    try {
      await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 });
      await writeFile(promptPath, renderHandoff(input), { mode: 0o600 });
    } catch {
      diagnostic('temporary workspace unavailable');
      return 1;
    }
    return await runContextWorker({ snapshot: snapshotPath, prompt: promptPath, argv: [...opts.argv] }, io);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
