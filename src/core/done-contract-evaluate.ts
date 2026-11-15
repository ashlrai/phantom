/**
 * done-contract.v1 evaluator (RQ-PHX-RECONCILEDONEEVAL09SNX1), reconciled from
 * PR #4165 (evaluateDoneContract, attestedIds, acceptance evidence, handoff) on
 * top of the merged planner. This is the only place a contract command starts a
 * process, and only when a caller invokes evaluateDoneContract explicitly:
 * previewing, importing and loading never run anything. It runs repository code,
 * so call it only for a trusted worktree.
 *
 * Child output is never captured or published; results are safe categories.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  DONE_CONTRACT_CLOSE, DONE_CONTRACT_OPEN, MAX_NOTES_BYTES, planDoneContract,
  type DoneContractSource, type DonePlan, type DonePlanError,
} from './done-contract-plan.js';

export const DONE_EVALUATION_SCHEMA = 'done-contract.evaluation.v1' as const;
/** Cap on the summed wall time of all checks; checks past it are reported as timeouts, not run. */
export const MAX_TOTAL_MS = 3_600_000;

export type CheckOutcome = 'passed' | 'failed' | 'timeout' | 'error' | 'unresolved' | 'rejected';
export type AcceptanceStatus = 'proven' | 'attested' | 'unproven' | 'manual' | 'optional-unmet';
export type DoneVerdict = 'passed' | 'passed-manual-pending' | 'failed';

export interface DoneRunResult { status: number | null; error?: { code?: string } | null }
/** argv array, confined absolute cwd, time bound. Must not surface child output. */
export type DoneRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => DoneRunResult;

const defaultRunner: DoneRunner = (argv, cwd, timeoutMs) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', stdio: 'ignore', shell: false, windowsHide: true });
  return { status: r.status, error: r.error ? { code: (r.error as NodeJS.ErrnoException).code } : null };
};

export interface DoneCheckResult {
  id: string;
  from: 'floor-check' | 'floor-command' | 'verify';
  required: boolean;
  outcome: CheckOutcome;
  ok: boolean;
  exitCode: number | null;
  secs: number;
}
export interface DoneAcceptanceResult { id: string; text: string; required: boolean; evidence: string; status: AcceptanceStatus; detail: string }
export interface DoneEvaluation {
  schema: typeof DONE_EVALUATION_SCHEMA;
  verdict: DoneVerdict;
  pass: boolean;
  mode: 'contract' | 'legacy-notes' | 'invalid';
  source: DoneContractSource;
  job: string | null;
  notesFile: string | null;
  notesPresent: boolean;
  checks: DoneCheckResult[];
  acceptance: DoneAcceptanceResult[];
  error: DonePlanError | 'notes-missing' | 'notes-missing-or-empty' | 'unreadable' | null;
}

// ─── Confined reads (worktree-relative; no symlink escape, no leaf link) ─────

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/** Real path of a worktree-relative entry, or null when absent, linked, or outside the real worktree. */
function confinedEntry(realRoot: string, rel: string): { path: string; isFile: boolean; isDir: boolean } | null {
  try {
    const path = join(realRoot, rel);
    if (lstatSync(path).isSymbolicLink() || !inside(realRoot, realpathSync(path))) return null;
    const stat = lstatSync(path);
    return { path, isFile: stat.isFile(), isDir: stat.isDirectory() };
  } catch { return null; }
}

function readNotes(realRoot: string, rel: string): string | null {
  const entry = confinedEntry(realRoot, rel);
  if (!entry?.isFile) return null;
  let fd: number | undefined;
  try {
    fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_NOTES_BYTES) return null;
    const buf = Buffer.alloc(stat.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.toString('utf8', 0, got);
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// ─── Checklist attestation (the batcher grammar, from #4165) ───────────────

const CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*([A-Za-z0-9._-]+)\s*(?:—|–|-|:)+\s*([A-Za-z]*)/gm;
const NEGATIVE_WORDS = new Set(['failed', 'skipped', 'deferred', 'blocked', 'pending', 'unreported', 'todo']);

/** Ids the notes attest done: checked box and a non-negative status word; the last line per id wins. */
export function attestedIds(notes: string): Set<string> {
  const seen = new Map<string, boolean>();
  for (const m of notes.matchAll(CHECKBOX)) seen.set(m[2]!, m[1] !== ' ' && !NEGATIVE_WORDS.has((m[3] ?? '').toLowerCase()));
  return new Set([...seen].filter(([, ok]) => ok).map(([id]) => id));
}

/** The contract's own embed region is declaration, not attestation: its checklist lines must not self-attest. */
function withoutEmbed(notes: string): string {
  const open = notes.indexOf(DONE_CONTRACT_OPEN);
  if (open === -1) return notes;
  const close = notes.indexOf(DONE_CONTRACT_CLOSE, open);
  return notes.slice(0, open) + (close === -1 ? '' : notes.slice(close + DONE_CONTRACT_CLOSE.length));
}

// ─── Evaluation ────────────────────────────────────────────────────────────

function runCheck(realRoot: string, check: DonePlan['checks'][number], run: DoneRunner, budgetLeft: number): { outcome: CheckOutcome; exitCode: number | null } {
  if (!check.resolved || check.argv === null) return { outcome: 'unresolved', exitCode: null };
  const cwd = check.cwd === '.' ? { path: realRoot, isDir: true } : confinedEntry(realRoot, check.cwd);
  if (!cwd?.isDir) return { outcome: 'rejected', exitCode: null };
  if (budgetLeft <= 0) return { outcome: 'timeout', exitCode: null };
  const dir = cwd.path;
  try {
    const r = run(check.argv, dir, Math.min(check.timeoutMs, budgetLeft));
    if (r.error) return { outcome: r.error.code === 'ETIMEDOUT' ? 'timeout' : 'error', exitCode: null };
    return r.status === 0 ? { outcome: 'passed', exitCode: 0 } : { outcome: 'failed', exitCode: r.status };
  } catch { return { outcome: 'error', exitCode: null }; }
}

const invalid = (source: DoneContractSource, error: DoneEvaluation['error']): DoneEvaluation => ({
  schema: DONE_EVALUATION_SCHEMA, verdict: 'failed', pass: false, mode: 'invalid', source, job: null,
  notesFile: null, notesPresent: false, checks: [], acceptance: [], error,
});

/**
 * Evaluate the frozen done-contract of a trusted worktree. A claimed but
 * unusable contract fails closed before anything runs. With no contract the
 * legacy rule applies: notes must be present and non-empty. With a contract,
 * every required check must pass and every required acceptance item be proven
 * or attested; optional failures stay visible but do not fail it. `manual`
 * items are human judgement: reported, never machine proof, never blocking.
 */
export function evaluateDoneContract(
  worktree: string,
  opts: { contractPath?: string } = {},
  deps: { runner?: DoneRunner; now?: () => number } = {},
): DoneEvaluation {
  const run = deps.runner ?? defaultRunner;
  const now = deps.now ?? (() => performance.now());
  let planned: ReturnType<typeof planDoneContract>;
  let realRoot: string;
  try {
    planned = planDoneContract(worktree, opts);
    realRoot = realpathSync(worktree);
  } catch { return invalid('none', 'unreadable'); }
  const { load, plan } = planned;
  if (load.error || !plan) return invalid(load.source, load.error ?? 'unreadable');

  if (plan.mode === 'legacy-notes') {
    return {
      schema: DONE_EVALUATION_SCHEMA, verdict: plan.legacyNotesPresent ? 'passed' : 'failed', pass: plan.legacyNotesPresent,
      mode: 'legacy-notes', source: plan.source, job: null, notesFile: plan.notesFile, notesPresent: plan.legacyNotesPresent,
      checks: [], acceptance: [], error: plan.legacyNotesPresent ? null : 'notes-missing-or-empty',
    };
  }

  const started = now();
  const checks: DoneCheckResult[] = plan.checks.map((check) => {
    const t0 = now();
    const { outcome, exitCode } = runCheck(realRoot, check, run, MAX_TOTAL_MS - (t0 - started));
    return {
      id: check.id, from: check.from, required: check.required, outcome, ok: outcome === 'passed', exitCode,
      secs: Math.round(Math.max(0, now() - t0) / 10) / 100,
    };
  });
  const byId = new Map(checks.map((c) => [c.id, c]));

  const notes = plan.notesFile === null ? null : readNotes(realRoot, plan.notesFile);
  const notesPresent = notes !== null && notes.trim().length > 0;
  const attested = notes === null ? new Set<string>() : attestedIds(withoutEmbed(notes));

  const acceptance = plan.acceptance.map((item): DoneAcceptanceResult => {
    const base = { id: item.id, text: item.text, required: item.required, evidence: item.evidence };
    const unmet: AcceptanceStatus = item.required ? 'unproven' : 'optional-unmet';
    const result = (status: AcceptanceStatus, detail: string): DoneAcceptanceResult => ({ ...base, status, detail });
    if (item.evidence === 'manual') return result('manual', 'needs human judgement; not machine-verified');
    if (item.evidence === 'notes') {
      return attested.has(item.id) ? result('attested', 'checked in notes') : result(unmet, 'no checked attestation line in notes');
    }
    const ref = /^command:(.+)$/.exec(item.evidence)?.[1];
    if (ref !== undefined) {
      const check = byId.get(ref);
      if (check?.ok) return result('proven', `command ${ref} exited 0`);
      return result(unmet, check ? `command ${ref} did not pass (${check.outcome})` : `command ${ref} was not run`);
    }
    const file = /^file:(.+)$/.exec(item.evidence)?.[1];
    if (file !== undefined) {
      return confinedEntry(realRoot, file) ? result('proven', 'file present inside the worktree') : result(unmet, 'file absent or outside the worktree');
    }
    return result(unmet, 'unknown evidence kind');
  });

  const notesRequired = plan.notesFile !== null;
  const manualPending = acceptance.some((a) => a.status === 'manual');
  const pass = checks.every((c) => c.ok || !c.required)
    && acceptance.every((a) => a.status !== 'unproven')
    && (!notesRequired || notesPresent);
  return {
    schema: DONE_EVALUATION_SCHEMA,
    verdict: !pass ? 'failed' : manualPending ? 'passed-manual-pending' : 'passed',
    pass, mode: 'contract', source: plan.source, job: plan.job, notesFile: plan.notesFile, notesPresent, checks, acceptance,
    error: notesRequired && !notesPresent ? 'notes-missing-or-empty' : null,
  };
}

/** Safe stderr-style handoff summary: ids, statuses and categories only. */
export function doneContractHandoff(e: DoneEvaluation): string {
  const lines = [
    `Done contract: ${e.verdict.toUpperCase()} (mode=${e.mode}${e.job ? ` job=${e.job}` : ''} source=${e.source})`,
    `Notes: ${e.notesFile ?? 'not required'}${e.notesFile ? (e.notesPresent ? ' present' : ' missing or empty') : ''}`,
    `Checks: ${e.checks.filter((c) => c.ok).length}/${e.checks.length} passed`,
  ];
  for (const c of e.checks) lines.push(`${c.id} (${c.from}${c.required ? '' : ', optional'}): ${c.ok ? 'PASS' : `FAIL ${c.outcome}${c.exitCode !== null ? ` exit ${c.exitCode}` : ''}`}`);
  for (const a of e.acceptance) lines.push(`${a.id}: ${a.status} — ${a.detail}`);
  if (e.acceptance.some((a) => a.status === 'manual')) lines.push('Manual items need human judgement; they are not machine proof.');
  if (e.error) lines.push(`Error: ${e.error}`);
  lines.push('Local verdict only; output withheld. No publish or merge performed.');
  return lines.join('\n');
}
