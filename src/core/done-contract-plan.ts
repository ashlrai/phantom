/**
 * done-contract.v1 preview (RQ-PHX-RECONCILEDONEPLAN09SNV2): schema validation,
 * embedded-contract extraction, bounded loading and a no-execution plan,
 * reconciled from PR #4165 (src/core/done-contract.ts). Nothing here starts a
 * process; the evaluator and `verify done` wiring are not part of this slice.
 *
 * Errors are safe categories only. Contract text, JSON, argv and parser
 * messages never reach an error.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { changeCommands, checkNames } from './verify-change.js';

export const DONE_CONTRACT_SCHEMA = 'done-contract.v1' as const;
export const DONE_CONTRACT_FILE = 'DONE_CONTRACT.json';
export const DONE_NOTES_FILE = 'BRIDGE_NOTES.md';
export const DONE_CONTRACT_OPEN = `<!-- done-contract:${DONE_CONTRACT_SCHEMA} -->`;
export const DONE_CONTRACT_CLOSE = '<!-- /done-contract -->';
export const MAX_CONTRACT_BYTES = 262_144;
export const MAX_NOTES_BYTES = 65_536;
export const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;

export type DonePlanError =
  | 'not-found' | 'path-escape' | 'symlink' | 'not-regular-file' | 'oversize' | 'unreadable'
  | 'no-fenced-json' | 'not-json' | 'schema-invalid' | 'duplicate-id' | 'unresolved-command-ref'
  | 'bad-file-evidence' | 'no-enforceable-layer';
const CATEGORIES: ReadonlySet<string> = new Set<DonePlanError>(['duplicate-id', 'unresolved-command-ref', 'bad-file-evidence', 'no-enforceable-layer']);

class PlanError extends Error {
  constructor(readonly category: DonePlanError) { super(category); }
}

const ITEM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRINTABLE = /^[\x20-\x7E]+$/;
const iso = (s: string) => /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));
const isWorktreePath = (s: string): boolean =>
  PRINTABLE.test(s) && !s.startsWith('/') && !/^[A-Za-z]:/.test(s) && !s.includes('\\') && !s.split('/').includes('..');
const relPath = z.string().min(1).max(512).refine(isWorktreePath);
const printable = z.string().min(1).max(512).regex(PRINTABLE);

const commandSchema = z.object({
  id: z.string().regex(ITEM_ID),
  cmd: z.array(printable).min(1).max(64),
  cwd: relPath.optional(),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
  required: z.boolean().optional(),
}).strict();

const floorSchema = z.object({
  checks: z.array(z.enum(checkNames)).min(1).max(checkNames.length).optional(),
  commands: z.array(commandSchema).min(1).max(64).optional(),
}).strict().refine((f) => (f.checks?.length ?? 0) + (f.commands?.length ?? 0) > 0);

const acceptanceSchema = z.object({
  id: z.string().regex(ITEM_ID),
  text: z.string().min(1).max(4_096).regex(PRINTABLE),
  evidence: z.string().regex(/^(notes|manual|command:[a-z0-9][a-z0-9._-]{0,63}|file:.+)$/).optional(),
  required: z.boolean().optional(),
}).strict();

export const doneContractSchema = z.object({
  schema: z.literal(DONE_CONTRACT_SCHEMA),
  job: z.string().regex(JOB_ID).optional(),
  frozenAt: z.string().refine(iso).optional(),
  floor: floorSchema.optional(),
  acceptance: z.array(acceptanceSchema).min(1).max(64).optional(),
  verify: z.array(commandSchema).min(1).max(64).optional(),
  notesFile: z.union([relPath.refine((s) => !s.includes('/')), z.null()]).optional(),
}).strict().superRefine((contract, ctx) => {
  const issue = (message: DonePlanError) => ctx.addIssue({ code: 'custom', message });
  const ids = new Set<string>();
  const claim = (id: string) => (ids.has(id) ? issue('duplicate-id') : void ids.add(id));
  for (const c of [...(contract.floor?.commands ?? []), ...(contract.verify ?? [])]) claim(c.id);
  for (const check of contract.floor?.checks ?? []) claim(check);
  const items = new Set<string>();
  for (const item of contract.acceptance ?? []) {
    if (items.has(item.id)) issue('duplicate-id');
    items.add(item.id);
    const ref = /^command:(.+)$/.exec(item.evidence ?? '')?.[1];
    if (ref !== undefined && !ids.has(ref)) issue('unresolved-command-ref');
    const file = /^file:(.+)$/.exec(item.evidence ?? '')?.[1];
    if (file !== undefined && !isWorktreePath(file)) issue('bad-file-evidence');
  }
  if (!contract.floor && !contract.acceptance && !contract.verify) issue('no-enforceable-layer');
});
export type DoneContract = z.infer<typeof doneContractSchema>;

export function parseDoneContract(text: string): DoneContract {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new PlanError('not-json'); }
  const result = doneContractSchema.safeParse(value);
  if (result.success) return result.data;
  // Structural failures win; refinement categories surface only when the shape itself is valid.
  const issues = result.error.issues;
  const semantic = issues.every((i) => CATEGORIES.has(i.message)) ? issues[0]?.message : undefined;
  throw new PlanError((semantic as DonePlanError | undefined) ?? 'schema-invalid');
}

/** First fenced JSON in the marked region; null when unmarked, a PlanError when marked but unusable. */
export function extractDoneContract(markdown: string): DoneContract | null {
  const open = markdown.indexOf(DONE_CONTRACT_OPEN);
  if (open === -1) return null;
  const close = markdown.indexOf(DONE_CONTRACT_CLOSE, open);
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(markdown.slice(open, close === -1 ? undefined : close));
  if (!fence) throw new PlanError('no-fenced-json');
  return parseDoneContract(fence[1]!);
}

// ─── Bounded, confined loading ─────────────────────────────────────

/** Read a regular, non-symlink file under realRoot, at most max bytes. Never follows a leaf link. */
function readConfined(realRoot: string, path: string, max: number): string {
  let parent: string;
  try { parent = realpathSync(dirname(path)); } catch { throw new PlanError('not-found'); }
  if (parent !== realRoot && !parent.startsWith(realRoot + sep)) throw new PlanError('path-escape');
  let stat;
  try { stat = lstatSync(path); } catch { throw new PlanError('not-found'); }
  if (stat.isSymbolicLink()) throw new PlanError('symlink');
  if (!stat.isFile()) throw new PlanError('not-regular-file');
  if (stat.size > max) throw new PlanError('oversize');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fstat = fstatSync(fd);
    if (!fstat.isFile()) throw new PlanError('not-regular-file');
    if (fstat.size > max) throw new PlanError('oversize');
    const buf = Buffer.alloc(fstat.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.toString('utf8', 0, got);
  } catch (error) {
    throw error instanceof PlanError ? error : new PlanError('unreadable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const exists = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };

export type DoneContractSource = 'contract-file' | 'notes-embed' | 'none';
export interface DoneContractLoad {
  source: DoneContractSource;
  contract: DoneContract | null;
  /** Non-null when a contract was claimed but unusable: fail closed, never legacy mode. */
  error: DonePlanError | null;
  /** Legacy mode only: whether the freeform notes file is present and non-empty. */
  legacyNotesPresent: boolean;
}

/** Precedence: explicit contract > root DONE_CONTRACT.json > BRIDGE_NOTES.md embed > none. */
export function loadDoneContract(worktree: string, opts: { contractPath?: string } = {}): DoneContractLoad {
  const realRoot = realpathSync(worktree);
  const fail = (source: DoneContractSource, error: unknown): DoneContractLoad =>
    ({ source, contract: null, error: error instanceof PlanError ? error.category : 'unreadable', legacyNotesPresent: false });
  const fromFile = (source: DoneContractSource, path: string, max: number, parse: (t: string) => DoneContract | null): DoneContractLoad | null => {
    try {
      const contract = parse(readConfined(realRoot, path, max));
      return contract ? { source, contract, error: null, legacyNotesPresent: false } : null;
    } catch (error) {
      return fail(source, error);
    }
  };
  if (opts.contractPath !== undefined) {
    if (opts.contractPath.split(/[\\/]/).includes('..')) return fail('contract-file', new PlanError('path-escape'));
    return fromFile('contract-file', resolve(realRoot, opts.contractPath), MAX_CONTRACT_BYTES, parseDoneContract)!;
  }
  const file = join(realRoot, DONE_CONTRACT_FILE);
  if (exists(file)) return fromFile('contract-file', file, MAX_CONTRACT_BYTES, parseDoneContract)!;
  const notes = join(realRoot, DONE_NOTES_FILE);
  if (!exists(notes)) return { source: 'none', contract: null, error: null, legacyNotesPresent: false };
  let text = '';
  const embedded = fromFile('notes-embed', notes, MAX_NOTES_BYTES, (t) => { text = t; return extractDoneContract(t); });
  return embedded ?? { source: 'none', contract: null, error: null, legacyNotesPresent: text.trim().length > 0 };
}

// ─── Plan (no execution) ───────────────────────────────────────────

export interface PlannedCheck {
  id: string;
  from: 'floor-check' | 'floor-command' | 'verify';
  argv: string[] | null;
  cwd: string;
  timeoutMs: number;
  required: boolean;
  resolved: boolean;
}
export interface DonePlan {
  source: DoneContractSource;
  mode: 'contract' | 'legacy-notes';
  job: string | null;
  frozenAt: string | null;
  notesFile: string | null;
  checks: PlannedCheck[];
  acceptance: { id: string; text: string; evidence: string; required: boolean }[];
  legacyNotesPresent: boolean;
  /** Set when named floor checks could not be resolved from the repository. */
  resolutionError: 'check-resolution-failed' | null;
}

/** Marker files changeCommands reads; any link or oversize file makes resolution unsafe rather than read it. */
function markersUnsafe(root: string): boolean {
  const names = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', '.github', '.github/workflows', '.github/tests/secret-shape/scrub.pl'];
  try {
    if (exists(join(root, '.github/workflows'))) names.push(...readdirSync(join(root, '.github/workflows')).filter((n) => /^ci\.ya?ml$/.test(n)).map((n) => `.github/workflows/${n}`));
    return names.some((n) => {
      try {
        const s = lstatSync(join(root, n));
        return s.isSymbolicLink() || (s.isFile() && s.size > MAX_CONTRACT_BYTES);
      } catch { return false; }
    });
  } catch { return true; }
}

export function planDoneContract(worktree: string, opts: { contractPath?: string } = {}): { load: DoneContractLoad; plan: DonePlan | null } {
  const load = loadDoneContract(worktree, opts);
  const { contract } = load;
  if (load.error) return { load, plan: null };
  const root = realpathSync(worktree);
  const base = { source: load.source, job: contract?.job ?? null, frozenAt: contract?.frozenAt ?? null, legacyNotesPresent: load.legacyNotesPresent };
  if (!contract) {
    return { load, plan: { ...base, mode: 'legacy-notes', notesFile: DONE_NOTES_FILE, checks: [], acceptance: [], resolutionError: null } };
  }
  let detected: ReturnType<typeof changeCommands> = {};
  let resolutionError: DonePlan['resolutionError'] = null;
  if ((contract.floor?.checks?.length ?? 0) > 0) {
    try {
      if (markersUnsafe(root)) throw new Error('unsafe');
      detected = changeCommands(root);
    } catch { resolutionError = 'check-resolution-failed'; }
  }
  const checks: PlannedCheck[] = (contract.floor?.checks ?? []).map((name) => {
    const argv = detected[name] ?? null;
    return { id: name, from: 'floor-check', argv, cwd: '.', timeoutMs: DEFAULT_TIMEOUT_MS, required: true, resolved: argv !== null };
  });
  for (const [from, list] of [['floor-command', contract.floor?.commands], ['verify', contract.verify]] as const) {
    for (const c of list ?? []) {
      checks.push({ id: c.id, from, argv: [...c.cmd], cwd: c.cwd ?? '.', timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS, required: c.required ?? true, resolved: true });
    }
  }
  const acceptance = (contract.acceptance ?? []).map((a) => ({ id: a.id, text: a.text, evidence: a.evidence ?? 'notes', required: a.required ?? true }));
  const notesFile = contract.notesFile === undefined ? DONE_NOTES_FILE : contract.notesFile;
  return { load, plan: { ...base, mode: 'contract', notesFile, checks, acceptance, resolutionError } };
}
