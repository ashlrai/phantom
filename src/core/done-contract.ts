/**
 * done-contract.v1 — a layered, file-based contract for what "done" means on
 * one agent job (RQ-SWE5-DONE-CONTRACT; research digest item 3).
 *
 * Three layers, all optional individually but never all absent:
 *
 *   1. `floor`      — the framework floor every job must pass: named
 *                     repository checks (`typecheck`, `unit`, `lint`,
 *                     `secrets`) resolved repo-agnostically by
 *                     src/core/verify-change.ts, or explicit commands.
 *   2. `acceptance` — per-job acceptance criteria frozen into the dispatch
 *                     prompt at enqueue time; the worker copies the contract
 *                     block verbatim into the notes file and attests each
 *                     item it cannot prove mechanically.
 *   3. `verify`     — extra per-job commands whose exit codes prove criteria.
 *
 * The contract is file-based. Two carriers:
 *
 *   - `DONE_CONTRACT.json` at the worktree root — for repos and pipelines
 *     where an extra untracked file is allowed.
 *   - An embed block inside `BRIDGE_NOTES.md` — for the bridge pipeline,
 *     whose integration proof requires BRIDGE_NOTES.md to be the only
 *     untracked file in a finished worktree:
 *
 *         <!-- done-contract:done-contract.v1 -->
 *         ```json
 *         { ...contract... }
 *         ```
 *         <!-- /done-contract -->
 *
 *     Other lines inside the markers (a per-item checklist the worker keeps
 *     current) are ignored by the parser; only the fenced JSON binds.
 *
 * `phm verify done` is the single generic validator. When no contract exists
 * it evaluates the legacy freeform-notes expectation (a present, non-empty
 * notes file), so jobs dispatched before contracts existed stay valid —
 * the contract replaces freeform BRIDGE_NOTES expectations incrementally.
 *
 * Commands run through an injected runner; the default is spawnSync with no
 * shell, per-command timeouts, an 8 MiB output cap and withheld child output
 * so credential material cannot enter a verdict. `cwd` values are confined
 * under the worktree root. A committed DONE_CONTRACT.json decides which
 * verify commands run — it belongs in the same owner-lane class as
 * ashlr.verify.json (follow-up: protected-paths entry + CODEOWNERS regen).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { changeCommands, checkNames } from './verify-change.js';

export const DONE_CONTRACT_SCHEMA = 'done-contract.v1' as const;
export const DONE_CONTRACT_FILE = 'DONE_CONTRACT.json';
export const DONE_NOTES_FILE = 'BRIDGE_NOTES.md';
export const DONE_CONTRACT_OPEN = `<!-- done-contract:${DONE_CONTRACT_SCHEMA} -->`;
export const DONE_CONTRACT_CLOSE = '<!-- /done-contract -->';
/** Mirrors batcher.py's BRIDGE_NOTES parse bound. */
export const MAX_CONTRACT_BYTES = 262_144;
/** Mirrors integrated-merge.py's unsafe-notes bound. */
export const MAX_NOTES_BYTES = 65_536;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_TIMEOUT_MS = 3_600_000;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ITEM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRINTABLE = /^[\x20-\x7E]+$/;
const iso = (s: string) => /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));

/** Printable-ASCII relative path confined to the worktree: no drive letter, leading slash, backslash or `..` segment. */
const isWorktreePath = (s: string): boolean =>
  PRINTABLE.test(s) && !s.startsWith('/') && !/^[A-Za-z]:/.test(s) && !s.includes('\\') && !s.split('/').includes('..');
const relPath = z.string().min(1).max(512).refine(isWorktreePath, 'relative worktree path only (printable ASCII, no absolute path, backslash or .. segment)');
const rootPath = relPath.refine((s) => !s.includes('/'), 'a filename at the worktree root');

export const doneContractCommandSchema = z.object({
  /** Stable id acceptance items reference through `command:<id>`; check names and command ids share one namespace. */
  id: z.string().regex(ITEM_ID, 'lowercase id: a-z 0-9 . _ -'),
  /** argv passed directly to the runner — no shell is ever invoked. */
  cmd: z.array(z.string().min(1).max(512).refine(PRINTABLE.test.bind(PRINTABLE), 'printable ASCII')).min(1).max(64),
  /** Relative directory inside the worktree; defaults to the root. */
  cwd: relPath.optional(),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
  /** Default true. Optional commands run and report but never fail the verdict. */
  required: z.boolean().optional(),
}).strict();
export type DoneContractCommand = z.infer<typeof doneContractCommandSchema>;

const floorSchema = z.object({
  /** Check names resolved through changeCommands(): works on package.json, Cargo, pyproject, Go and CI-declared repos. */
  checks: z.array(z.enum(checkNames)).min(1).max(checkNames.length).optional(),
  /** Explicit floor commands — e.g. frozen copies of the repo's verify contract. */
  commands: z.array(doneContractCommandSchema).min(1).max(64).optional(),
}).strict().refine((f) => (f.checks?.length ?? 0) > 0 || (f.commands?.length ?? 0) > 0, {
  message: 'floor needs at least one check or command',
});
export type DoneContractFloor = z.infer<typeof floorSchema>;

const EVIDENCE = /^(notes|manual|command:[a-z0-9][a-z0-9._-]{0,63}|file:.+)$/;
const acceptanceSchema = z.object({
  id: z.string().regex(ITEM_ID, 'lowercase id: a-z 0-9 . _ -'),
  /** The frozen criterion text — copied verbatim from the dispatch prompt. */
  text: z.string().min(1).max(4_096).refine(PRINTABLE.test.bind(PRINTABLE), 'printable ASCII'),
  /**
   * `notes` (default): the worker attests the item with a checked `- [x] <id> — done: …`
   * line in the notes file (the batcher checklist grammar). `command:<id>`: the named
   * floor/verify command exited 0. `file:<path>`: the path exists under the worktree.
   * `manual`: needs human judgement — always reported, never blocks the verdict.
   */
  evidence: z.string().regex(EVIDENCE, 'notes | manual | command:<id> | file:<path>').optional(),
  required: z.boolean().optional(),
}).strict();
export type DoneContractAcceptance = z.infer<typeof acceptanceSchema>;

export const doneContractSchema = z.object({
  schema: z.literal(DONE_CONTRACT_SCHEMA),
  /** Dispatch job id the contract was frozen for. */
  job: z.string().regex(JOB_ID).optional(),
  /** When the criteria were frozen into the prompt. */
  frozenAt: z.string().refine(iso, 'ISO-8601 timestamp').optional(),
  floor: floorSchema.optional(),
  acceptance: z.array(acceptanceSchema).min(1).max(64).optional(),
  verify: z.array(doneContractCommandSchema).min(1).max(64).optional(),
  /**
   * Notes file carrying attestations; default BRIDGE_NOTES.md. `null` opts the
   * contract out of notes entirely (notes-evidence items then cannot be
   * attested and fail closed when required).
   */
  notesFile: z.union([rootPath, z.null()]).optional(),
}).strict()
  .superRefine((contract, ctx) => {
    const ids = new Map<string, string>();
    for (const [where, list] of [['floor.commands', contract.floor?.commands], ['verify', contract.verify]] as const) {
      for (const [i, c] of (list ?? []).entries()) {
        const seen = ids.get(c.id);
        if (seen !== undefined) ctx.addIssue({ code: 'custom', path: [where, i, 'id'], message: `duplicate command id (also at ${seen})` });
        else ids.set(c.id, `${where}[${i}]`);
      }
    }
    for (const check of contract.floor?.checks ?? []) {
      const seen = ids.get(check);
      if (seen !== undefined) ctx.addIssue({ code: 'custom', path: ['floor', 'checks'], message: `floor check "${check}" collides with command id at ${seen}` });
      else ids.set(check, 'floor.checks');
    }
    const seenItems = new Set<string>();
    for (const [i, item] of (contract.acceptance ?? []).entries()) {
      if (seenItems.has(item.id)) ctx.addIssue({ code: 'custom', path: ['acceptance', i, 'id'], message: 'duplicate acceptance id' });
      else seenItems.add(item.id);
      const ref = /^command:(.+)$/.exec(item.evidence ?? '')?.[1];
      if (ref !== undefined && !ids.has(ref)) {
        ctx.addIssue({ code: 'custom', path: ['acceptance', i, 'evidence'], message: `command:${ref} names no declared check or command` });
      }
      const file = /^file:(.+)$/.exec(item.evidence ?? '')?.[1];
      if (file !== undefined && !isWorktreePath(file)) {
        ctx.addIssue({ code: 'custom', path: ['acceptance', i, 'evidence'], message: 'file evidence must be a relative worktree path' });
      }
    }
    const layers = (contract.floor !== undefined ? 1 : 0)
      + ((contract.acceptance?.length ?? 0) > 0 ? 1 : 0)
      + ((contract.verify?.length ?? 0) > 0 ? 1 : 0);
    if (layers === 0) ctx.addIssue({ code: 'custom', path: [], message: 'contract carries no enforceable layer' });
  });
export type DoneContract = z.infer<typeof doneContractSchema>;

/** Parse contract JSON text; throws Error with the first schema issue. */
export function parseDoneContract(text: string): DoneContract {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('contract is not JSON');
  }
  const result = doneContractSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length ? issue.path.map(String).join('.') : 'contract';
    throw new Error(`invalid contract: ${where}: ${issue?.message ?? 'unknown issue'}`);
  }
  return result.data;
}

/** The embed block a prompt carries and the worker copies verbatim into the notes file. */
export function doneContractBlock(contract: DoneContract): string {
  return `${DONE_CONTRACT_OPEN}\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n${DONE_CONTRACT_CLOSE}`;
}

/**
 * Extract the contract bound inside markdown between the markers — the first
 * ```json fence in the region. Returns null when no block exists. Throws
 * Error when a marked block exists but carries no parseable contract, so a
 * corrupted block fails closed instead of reverting a job to freeform notes.
 */
export function extractDoneContract(markdown: string): DoneContract | null {
  const open = markdown.indexOf(DONE_CONTRACT_OPEN);
  if (open === -1) return null;
  const close = markdown.indexOf(DONE_CONTRACT_CLOSE, open);
  const region = markdown.slice(open, close === -1 ? undefined : close + DONE_CONTRACT_CLOSE.length);
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(region);
  if (!fence) throw new Error('done-contract block carries no fenced JSON');
  return parseDoneContract(fence[1]!);
}

export type DoneContractSource = 'contract-file' | 'notes-embed' | 'none';
export interface DoneContractLoad {
  source: DoneContractSource;
  contract: DoneContract | null;
  /** Non-null when a contract was claimed but unreadable or malformed — fail closed. */
  error: string | null;
}

interface FsDeps {
  exists: (path: string) => boolean;
  isFile: (path: string) => boolean;
  size: (path: string) => number;
  read: (path: string) => string;
}
const realFs: FsDeps = {
  exists: (p) => existsSync(p),
  isFile: (p) => lstatSync(p).isFile(),
  size: (p) => lstatSync(p).size,
  read: (p) => readFileSync(p, 'utf8'),
};

function readBound(path: string, max: number, fs: FsDeps): string {
  if (!fs.isFile(path)) throw new Error('not a regular file');
  if (fs.size(path) > max) throw new Error('oversized file');
  return fs.read(path);
}

/**
 * Locate and parse the contract for a worktree: an explicit `contractPath`,
 * then `DONE_CONTRACT.json` at the root, then an embed block inside the notes
 * file. A claimed-but-broken contract is reported as `error`, never silently
 * downgraded to notes mode.
 */
export function loadDoneContract(
  worktree: string,
  opts: { contractPath?: string; notesFile?: string } = {},
  fs: FsDeps = realFs,
): DoneContractLoad {
  const root = resolve(worktree);
  const notesPath = join(root, opts.notesFile ?? DONE_NOTES_FILE);
  if (opts.contractPath !== undefined) {
    const path = resolve(root, opts.contractPath);
    try {
      return { source: 'contract-file', contract: parseDoneContract(readBound(path, MAX_CONTRACT_BYTES, fs)), error: null };
    } catch (error) {
      return { source: 'contract-file', contract: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const file = join(root, DONE_CONTRACT_FILE);
  if (fs.exists(file)) {
    try {
      return { source: 'contract-file', contract: parseDoneContract(readBound(file, MAX_CONTRACT_BYTES, fs)), error: null };
    } catch (error) {
      return { source: 'contract-file', contract: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (fs.exists(notesPath) && fs.isFile(notesPath) && fs.size(notesPath) <= MAX_NOTES_BYTES) {
    try {
      const contract = extractDoneContract(fs.read(notesPath));
      if (contract) return { source: 'notes-embed', contract, error: null };
    } catch (error) {
      return { source: 'notes-embed', contract: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { source: 'none', contract: null, error: null };
}

/** The notes path a verdict applies: explicit option > contract override > BRIDGE_NOTES.md. */
export function contractNotesFile(contract: DoneContract | null, opts: { notesFile?: string } = {}): string | null {
  if (opts.notesFile !== undefined) return opts.notesFile;
  if (contract?.notesFile !== undefined) return contract.notesFile;
  return DONE_NOTES_FILE;
}

// ─── Checklist attestation (the batcher grammar) ──────────────────────

const CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*([A-Za-z0-9._-]+)\s*(?:—|–|-|:)+\s*([A-Za-z]*)/gm;
const NEGATIVE_WORDS = new Set(['failed', 'skipped', 'deferred', 'blocked', 'pending', 'unreported', 'todo']);

/** Ids the notes file attests done: checked checkbox and a status word that is not a retry/negative word. Last line per id wins. */
export function attestedIds(notes: string): Set<string> {
  const seen = new Map<string, boolean>();
  for (const m of notes.slice(0, MAX_CONTRACT_BYTES).matchAll(CHECKBOX)) {
    seen.set(m[2]!, m[1] !== ' ' && !NEGATIVE_WORDS.has((m[3] ?? '').toLowerCase()));
  }
  return new Set([...seen.entries()].filter(([, ok]) => ok).map(([id]) => id));
}

// ─── Command resolution and evaluation ────────────────────────────────

export interface ResolvedCommand {
  id: string;
  source: 'floor' | 'verify';
  argv: string[] | null;
  cwd: string;
  timeoutMs: number;
  required: boolean;
  /** False when a floor check name has no matching repository command. */
  resolved: boolean;
}

/** Confine a contract `cwd` under the worktree root; returns the absolute dir. */
function confinedCwd(root: string, cwd: string | undefined): string {
  const dir = cwd === undefined ? root : resolve(root, cwd);
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error(`command cwd escapes the worktree: ${cwd}`);
  return dir;
}

function resolveCommands(contract: DoneContract, root: string): ResolvedCommand[] {
  const out: ResolvedCommand[] = [];
  const detected = (contract.floor?.checks?.length ?? 0) > 0 ? changeCommands(root) : null;
  for (const name of contract.floor?.checks ?? []) {
    const argv = detected?.[name] ?? null;
    out.push({ id: name, source: 'floor', argv, cwd: root, timeoutMs: DEFAULT_TIMEOUT_MS, required: true, resolved: argv !== null });
  }
  for (const [source, list] of [['floor', contract.floor?.commands], ['verify', contract.verify]] as const) {
    for (const c of list ?? []) {
      out.push({
        id: c.id,
        source,
        argv: [...c.cmd],
        cwd: confinedCwd(root, c.cwd),
        timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        required: c.required ?? true,
        resolved: true,
      });
    }
  }
  return out;
}

/** What the validator would do, without running anything. */
export interface DoneContractPlan {
  mode: 'contract' | 'notes';
  job: string | null;
  source: DoneContractSource;
  notesFile: string | null;
  commands: ResolvedCommand[];
  acceptance: { id: string; evidence: string; required: boolean }[];
  error: string | null;
}

export function doneContractPlan(
  worktree: string,
  opts: { contractPath?: string; notesFile?: string } = {},
  fs: FsDeps = realFs,
): DoneContractPlan {
  const root = resolve(worktree);
  const loaded = loadDoneContract(root, opts, fs);
  const notesFile = contractNotesFile(loaded.contract, opts);
  if (!loaded.contract) {
    return { mode: 'notes', job: null, source: loaded.source, notesFile, commands: [], acceptance: [], error: loaded.error };
  }
  let commands: ResolvedCommand[] = [];
  let error = loaded.error;
  try {
    commands = resolveCommands(loaded.contract, root);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    mode: 'contract',
    job: loaded.contract.job ?? null,
    source: loaded.source,
    notesFile,
    commands,
    acceptance: (loaded.contract.acceptance ?? []).map((a) => ({ id: a.id, evidence: a.evidence ?? 'notes', required: a.required ?? true })),
    error,
  };
}

export type DoneContractRunResult = { status: number | null; error?: { message?: string } | null };
export type DoneContractRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => DoneContractRunResult;

/** Runs repository code: use only with a trusted worktree. No subprocess output is published. */
const defaultRunner: DoneContractRunner = (argv, cwd, timeoutMs) =>
  spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });

export interface DoneContractCheck {
  id: string;
  source: 'floor' | 'verify';
  required: boolean;
  ok: boolean;
  secs: number;
  first_error: string | null;
}
export type AcceptanceStatus = 'proven' | 'attested' | 'unproven' | 'manual' | 'optional-unmet';
export interface DoneContractAcceptanceResult { id: string; text: string; status: AcceptanceStatus; detail: string | null }

export interface DoneContractVerdict {
  pass: boolean;
  /** `contract` when a contract was interpreted; `notes` for the legacy freeform-notes expectation. */
  mode: 'contract' | 'notes';
  job: string | null;
  source: DoneContractSource;
  notes_file: string | null;
  notes_present: boolean;
  checks: DoneContractCheck[];
  acceptance: DoneContractAcceptanceResult[];
  error: string | null;
}

/**
 * Evaluate the done contract for a worktree. With no contract the legacy rule
 * applies: the notes file must exist, be a regular file, be non-empty and stay
 * under the integrated-merge bound. With a contract, every required command
 * must exit 0 and every required acceptance item must be proven or attested;
 * `manual` items are reported but never block. Child output never enters the
 * verdict — `first_error` is a safe category, like verifyChange.
 */
export function evaluateDoneContract(
  worktree: string,
  opts: { contractPath?: string; notesFile?: string } = {},
  deps: { runner?: DoneContractRunner; fs?: FsDeps; now?: () => number } = {},
): DoneContractVerdict {
  const root = resolve(worktree);
  const fs = deps.fs ?? realFs;
  const run = deps.runner ?? defaultRunner;
  const now = deps.now ?? (() => performance.now());
  const loaded = loadDoneContract(root, opts, fs);
  const notesFile = contractNotesFile(loaded.contract, opts);

  const notesPath = notesFile === null ? null : join(root, notesFile);
  let notes: string | null = null;
  let notesPresent = false;
  if (notesPath && fs.exists(notesPath)) {
    try {
      notes = readBound(notesPath, MAX_NOTES_BYTES, fs);
      notesPresent = notes.trim().length > 0;
    } catch {
      notesPresent = false;
    }
  }

  if (!loaded.contract) {
    const pass = loaded.error === null && notesPresent;
    return {
      pass, mode: loaded.error ? 'contract' : 'notes', job: null, source: loaded.source,
      notes_file: notesFile, notes_present: notesPresent, checks: [], acceptance: [],
      error: loaded.error ?? (notesPresent ? null : 'notes file missing or empty'),
    };
  }
  const contract = loaded.contract;
  const checksById = new Map<string, DoneContractCheck>();
  const checks: DoneContractCheck[] = [];
  let commands: ResolvedCommand[];
  try {
    commands = resolveCommands(contract, root);
  } catch (error) {
    return {
      pass: false, mode: 'contract', job: contract.job ?? null, source: loaded.source,
      notes_file: notesFile, notes_present: notesPresent, checks, acceptance: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  for (const command of commands) {
    const start = now();
    let ok = false;
    let firstError: string | null = null;
    if (!command.resolved || command.argv === null) {
      firstError = 'No matching repository check configured';
    } else {
      const result = run(command.argv, command.cwd, command.timeoutMs);
      ok = result.status === 0 && !result.error;
      if (!ok) {
        firstError = result.error
          ? 'Check could not complete (tool unavailable, timeout or output limit)'
          : `Check exited ${result.status ?? 'without status'}; output withheld for credential safety`;
      }
    }
    const check: DoneContractCheck = {
      id: command.id, source: command.source, required: command.required, ok,
      secs: Math.round((now() - start) / 10) / 100, first_error: firstError,
    };
    checks.push(check);
    checksById.set(command.id, check);
  }

  const attested = notes === null ? new Set<string>() : attestedIds(notes);
  const acceptance = (contract.acceptance ?? []).map((item): DoneContractAcceptanceResult => {
    const required = item.required ?? true;
    const evidence = item.evidence ?? 'notes';
    const unmet: AcceptanceStatus = required ? 'unproven' : 'optional-unmet';
    if (evidence === 'manual') return { id: item.id, text: item.text, status: 'manual', detail: 'needs human judgement' };
    if (evidence === 'notes') {
      return attested.has(item.id)
        ? { id: item.id, text: item.text, status: 'attested', detail: `checked in ${notesFile}` }
        : { id: item.id, text: item.text, status: unmet, detail: 'no checked attestation line in notes' };
    }
    const ref = /^command:(.+)$/.exec(evidence)?.[1];
    if (ref !== undefined) {
      const check = checksById.get(ref);
      return check?.ok === true
        ? { id: item.id, text: item.text, status: 'proven', detail: `command ${ref} exited 0` }
        : { id: item.id, text: item.text, status: unmet, detail: check ? `command ${ref} did not pass` : `command ${ref} was not run` };
    }
    const file = /^file:(.+)$/.exec(evidence)?.[1];
    if (file !== undefined) {
      return fs.exists(join(root, file))
        ? { id: item.id, text: item.text, status: 'proven', detail: `${file} exists` }
        : { id: item.id, text: item.text, status: unmet, detail: `${file} absent` };
    }
    return { id: item.id, text: item.text, status: unmet, detail: `unknown evidence ${evidence}` };
  });

  const notesRequired = notesFile !== null;
  const pass =
    checks.every((c) => c.ok || !c.required) &&
    acceptance.every((a) => a.status === 'proven' || a.status === 'attested' || a.status === 'manual' || a.status === 'optional-unmet') &&
    (!notesRequired || notesPresent);
  return {
    pass, mode: 'contract', job: contract.job ?? null, source: loaded.source,
    notes_file: notesFile, notes_present: notesPresent, checks, acceptance,
    error: notesRequired && !notesPresent ? `${notesFile} missing or empty` : null,
  };
}

/** Stderr handoff lines, mirroring verifyChange's handoff shape. */
export function doneContractHandoff(verdict: DoneContractVerdict): string {
  const lines = [
    `Done contract: ${verdict.pass ? 'PASS' : 'FAIL'} (mode=${verdict.mode}${verdict.job ? ` job=${verdict.job}` : ''} source=${verdict.source})`,
    `Notes: ${verdict.notes_file ?? 'none'} ${verdict.notes_file ? (verdict.notes_present ? 'present' : 'absent') : 'not required'}`,
    `Checks run: ${verdict.checks.length}`,
    `Passed: ${verdict.checks.filter((c) => c.ok).length}`,
    `Failed: ${verdict.checks.filter((c) => !c.ok).length}`,
  ];
  for (const check of verdict.checks) {
    lines.push(`${check.id} (${check.source}${check.required ? '' : ', optional'}): ${check.ok ? 'PASS' : `FAIL — ${check.first_error ?? 'unknown'}`}`);
  }
  if (verdict.acceptance.length) {
    lines.push(`Acceptance: ${verdict.acceptance.filter((a) => a.status === 'proven' || a.status === 'attested').length}/${verdict.acceptance.length} satisfied`);
    for (const item of verdict.acceptance) lines.push(`${item.id}: ${item.status}${item.detail ? ` — ${item.detail}` : ''}`);
  }
  if (verdict.error) lines.push(`Error: ${verdict.error}`);
  lines.push('Local verdict only; inspect failures locally. No publish or merge performed.');
  return lines.join('\n');
}
