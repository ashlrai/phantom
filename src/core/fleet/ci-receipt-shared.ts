/**
 * Shared validation, GitHub API evidence parsing, and bounded CLI input helpers
 * for the fleet `ci-receipt-*` and `ci-resume-*` pipeline.
 */
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import type { GitRunner, GitRunResult } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';
import { isAwaitMs } from './needs-mason-answer-await.js';

export const CI_RUNNER_TIMEOUT_MS = 30_000;
export const CI_META_MAX_BYTES = 1024 * 1024;
export const CI_LIST_MAX_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ROWS = 2048;
const MAX_FIELD_CHARS = 200;

export const CI_RECEIPT_MAX_REASON = 200;
export const CI_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const CI_SHA40_RE = /^[0-9a-f]{40}$/i;
export const CI_HEX_REV_RE = /^[0-9a-f]{4,64}$/i;

export const CI_RECEIPT_REPORT_KEYS = [
  'version', 'total', 'bound', 'failed', 'notStarted', 'timedOut', 'aborted', 'entries',
] as const;
export const CI_RECEIPT_ENTRY_KEYS = [
  'repo', 'run', 'attempt', 'artifactName', 'outcome', 'prior', 'reason',
] as const;
const TARGET_KEYS = ['repo', 'run', 'attempt', 'artifactName'] as const;
export const CI_RECEIPT_OUTCOMES = new Set<string>(['bound', 'failed', 'not-started']);

export class CiResumeInputsError extends Error {}

// Function declaration, not a const arrow: the compiler only propagates
// never-returning CFA narrowing through declared functions.
export function failCiResume(message: string): never {
  throw new CiResumeInputsError(message);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainRecord(value) ? value : null;
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function isNonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** Non-empty bounded field string free of ASCII control bytes. */
export function artifactNameField(value: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : null;
}

/** Artifact name suitable for CLI/batch targets (never leading `-`). */
export function isValidArtifactNameFlag(value: unknown): value is string {
  return typeof value === 'string' && artifactNameField(value) === value && !value.startsWith('-');
}

/** Strict GitHub `owner/name` shape accepted by the ci-receipt/resume surfaces. */
export function isValidCiRepo(value: unknown): value is string {
  if (typeof value !== 'string' || !CI_REPO_RE.test(value)) return false;
  const owner = value.split('/')[0]!;
  return !owner.endsWith('-') && !owner.includes('--') && !value.endsWith('/.') && !value.endsWith('/..');
}

export interface CiReceiptTargetIdentity {
  repo: string;
  run: number;
  attempt: number;
  artifactName: string;
}

/** Validate the four exact target identity fields inside a record. */
export function isValidCiReceiptIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & CiReceiptTargetIdentity {
  return isValidCiRepo(value['repo'])
    && isPositiveId(value['run'])
    && isPositiveId(value['attempt'])
    && isValidArtifactNameFlag(value['artifactName']);
}

/** Validate a standalone `{repo, run, attempt, artifactName}` target object with no extra keys. */
export function isValidCiReceiptTarget(value: unknown): value is CiReceiptTargetIdentity {
  return isPlainRecord(value)
    && hasExactKeys(value, TARGET_KEYS)
    && isValidCiReceiptIdentity(value);
}

/** Canonical exact-identity key: repo case-insensitive like the binder, rest literal. */
export function ciReceiptTargetKey(target: CiReceiptTargetIdentity): string {
  return `${target.repo.toLowerCase()}\0${target.run}\0${target.attempt}\0${target.artifactName}`;
}

/** Scrub secrets, VT sequences, control bytes and line breaks; cap to CI_RECEIPT_MAX_REASON. */
export function cleanCiReceiptReason(value: string): string {
  // eslint-disable-next-line no-control-regex
  return scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, CI_RECEIPT_MAX_REASON);
}

export function assertRunnerResultOk(r: GitRunResult, bin: string, label: string): GitRunResult {
  if (r.missing) failCiResume(`${bin} is not installed`);
  if (r.timedOut) failCiResume(`${label} timed out`);
  if (r.truncated) failCiResume(`${label} output exceeded its bound`);
  if (r.code !== 0) {
    failCiResume(`${label} failed: ${scrubSecrets((r.stderr.split('\n')[0] ?? '').trim()).slice(0, 160)}`);
  }
  return r;
}

export async function runGhApi(
  gh: GitRunner,
  args: string[],
  maxStdoutBytes: number,
  label: string,
): Promise<GitRunResult> {
  let r: GitRunResult;
  try { r = await gh('gh', args, { cwd: tmpdir(), timeoutMs: CI_RUNNER_TIMEOUT_MS, maxStdoutBytes }); }
  catch { failCiResume(`${label} could not run`); }
  return assertRunnerResultOk(r, 'gh', label);
}

export function parseGhJsonOutput(r: GitRunResult, label: string): unknown {
  try { return JSON.parse(r.stdout); } catch { failCiResume(`${label} returned malformed JSON`); }
}

/** Slurped `gh api --paginate --slurp` pages; refuses inconsistent or partial counts. */
export function parseSlurpedPages(value: unknown, key: string, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) failCiResume(`${label} evidence is malformed`);
  const rows: Record<string, unknown>[] = [];
  let total: number | undefined;
  for (const page of value) {
    const p = asRecord(page);
    if (!p || !isNonNegativeInt(p['total_count'])
      || !Array.isArray(p[key]) || (total !== undefined && total !== p['total_count'])) {
      failCiResume(`${label} evidence is malformed`);
    }
    total = p['total_count'];
    for (const row of p[key] as unknown[]) {
      rows.push(asRecord(row) ?? failCiResume(`${label} evidence is malformed`));
    }
  }
  if (total === undefined || rows.length !== total || total > MAX_LIST_ROWS) {
    failCiResume(`${label} pagination is ambiguous`);
  }
  return rows;
}

export interface CiRunArtifactRow {
  id: number;
  name: string;
  expired: boolean;
  runId: number | null;
}

/** Bounded `--paginate --slurp` run-artifacts listing; validates every row shape. */
export function parseRunArtifactRows(value: unknown): CiRunArtifactRow[] {
  return parseSlurpedPages(value, 'artifacts', 'run artifacts').map((a): CiRunArtifactRow => {
    if (!isPositiveId(a['id']) || typeof a['expired'] !== 'boolean'
      || artifactNameField(a['name']) === null) {
      failCiResume('run artifacts evidence is malformed');
    }
    const wf = a['workflow_run'] === undefined || a['workflow_run'] === null
      ? null
      : asRecord(a['workflow_run']) ?? failCiResume('run artifacts evidence is malformed');
    const runId = wf === null
      ? null
      : Number.isSafeInteger(wf['id'])
        ? wf['id'] as number
        : failCiResume('run artifacts evidence is malformed');
    return { id: a['id'], name: a['name'] as string, expired: a['expired'], runId };
  });
}

/**
 * Resolve the single live bearer for `name` in `run`. Returns null when absent;
 * throws on duplicate bearers (including expired siblings), expiry or run mismatch.
 */
export function findSingleRunArtifactBearer(
  rows: readonly CiRunArtifactRow[],
  run: number,
  name: string,
): CiRunArtifactRow | null {
  const bearers = rows.filter((r) => r.name === name);
  if (bearers.length > 1) failCiResume(`artifact name "${name}" has ${bearers.length} bearers in run ${run}`);
  const only = bearers[0];
  if (!only) return null;
  if (only.expired) failCiResume(`artifact "${name}" in run ${run} is expired`);
  if (only.runId !== null && only.runId !== run) failCiResume(`artifact "${name}" does not belong to run ${run}`);
  return only;
}

export function parsePositiveIdFlag(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1
    ? Number(value)
    : null;
}

export function parseBoundedMsFlag(value: string | undefined, max: number): number | null {
  return value !== undefined && /^\d+$/.test(value) && isAwaitMs(Number(value), max)
    ? Number(value)
    : null;
}

export type BoundedUtf8InputRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'stdin_must_be_a_pipe' | 'input_too_large' | 'input_unreadable' };

/** Read a bounded fatal UTF-8 stream (used by `--stdin` batch/replan/retry/select CLIs). */
export async function readBoundedUtf8Input(
  input: AsyncIterable<string | Uint8Array>,
  maxBytes: number,
  rejectTty = false,
): Promise<BoundedUtf8InputRead> {
  if (rejectTty && (input as { isTTY?: boolean }).isTTY === true) {
    return { ok: false, reason: 'stdin_must_be_a_pipe' };
  }
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) return { ok: false, reason: 'input_too_large' };
      chunks.push(buffer);
    }
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, reason: 'input_unreadable' };
  }
}
