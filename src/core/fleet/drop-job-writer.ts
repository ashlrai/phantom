/**
 * core/fleet/drop-job-writer.ts — RQ-PHX-DROPJOBAPI31: write Phantom planner
 * jobs into the dispatchd drop folder the ingest already sweeps.
 *
 * THE ENVIRONMENT CONTRACT (not enforced here against the orchestrator — the
 * ingest on the host is the authority; this module mirrors it exactly):
 *   - the sweep reads `<runsDir>/leader/drop/claude/RQ-PHX-<id>.md`;
 *   - line 1 is exactly `#job repo=phantom lane=<lane> tier=<tier>`;
 *   - lane ∈ {claude, codex-personal, devin, codex-local},
 *     tier ∈ {frontier, work, mid, fast}, id ∈ [A-Z0-9]{3,40};
 *   - files over 8000 bytes, ids already used, and bodies naming protected
 *     operator paths (DENIED_TOKENS below) are rejected;
 *   - accepted files move to `queue/prompts/`; launched jobs leave
 *     `<runsDir>/RQ-PHX-<id>.prompt`; finished drops land in `leader/drop/done/`.
 *
 * runsDir resolves like every other runs reader (fleet-runs-api.ts,
 * runs-switches.ts): an explicit root, then ASHLR_RUNS_DIR, then
 * `~/.ashlr-runs` — always absolute. Every path composed here is checked to
 * stay inside that root, lexically and through symlinks: a `..` segment or a
 * drop directory replaced by a symlink to elsewhere is refused rather than
 * written outside the store.
 *
 * THE PUBLISH PRIMITIVE is temp-file + link(2), not rename(2): rename would
 * silently replace an existing job file, while link fails EEXIST — atomic and
 * never clobbering, which is what "an id already used" demands. The temp file
 * is dot-prefixed and suffixed so the sweep's `RQ-PHX-*.md` glob never sees
 * a half-written job.
 */

import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

export const DROP_JOB_LANES = ['claude', 'codex-personal', 'devin', 'codex-local'] as const;
export const DROP_JOB_TIERS = ['frontier', 'work', 'mid', 'fast'] as const;
export type DropJobLane = (typeof DROP_JOB_LANES)[number];
export type DropJobTier = (typeof DROP_JOB_TIERS)[number];

const LANES = new Set<string>(DROP_JOB_LANES);
const TIERS = new Set<string>(DROP_JOB_TIERS);

/** The id after `RQ-PHX-`. */
export const DROP_JOB_ID = /^[A-Z0-9]{3,40}$/;
/** A drop/queue file name carrying a valid id. */
export const DROP_JOB_FILE = /^RQ-PHX-([A-Z0-9]{3,40})\.md$/;
export const DROP_JOB_FILE_PREFIX = 'RQ-PHX-';
/** Whole file, header included — the ingest's hard ceiling. */
export const DROP_JOB_MAX_FILE_BYTES = 8000;
/** Above this many queued RQ-PHX prompts the writer sheds load (507). */
export const DROP_JOB_QUEUE_LIMIT = 40;
const TITLE_CHARS = 120;
/** Listing reads at most this much of a job file for its header and title. */
const LIST_READ_BYTES = 16 * 1024;

const HEADER_LINE = /^#job repo=phantom lane=(\S+) tier=(\S+)$/;
/** The denied-body tokens the ingest rejects on, spelled out once. */
const DENIED_TOKENS = ['.github/', '/.codex', 'auth.json', 'CODEOWNERS'] as const;
const DENIED_CONTENT = new RegExp(
  DENIED_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
);
/** Newline and tab are the only control characters a body may carry. */
const CONTROL_BESIDES_NL_TAB = /(?![\n\t])\p{Cc}/u;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DropJobInput {
  id: string;
  lane: string;
  tier: string;
  body: string;
}

export type DropJobValidation = { ok: true } | { ok: false; reasons: string[] };

export interface DropJobWritten {
  file: string;
  bytes: number;
  at: string;
}

export interface DropJobListItem {
  id: string;
  lane: string | null;
  tier: string | null;
  title: string | null;
  bytes: number;
  ageSeconds: number;
}

export class DropJobValidationError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`invalid drop job: ${reasons.join(', ')}`);
    this.name = 'DropJobValidationError';
  }
}

export class DropJobExistsError extends Error {
  constructor(public readonly id: string) {
    super(`drop job already exists: ${id}`);
    this.name = 'DropJobExistsError';
  }
}

/** A composed path would land outside the runs root — refused, never written. */
export class DropJobPathError extends Error {
  constructor(path: string) {
    super(`path escapes the drop root: ${basename(path)}`);
    this.name = 'DropJobPathError';
  }
}

// ---------------------------------------------------------------------------
// Root and path containment
// ---------------------------------------------------------------------------

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention. */
export function resolveDropJobRoot(override?: string): string {
  const dir = override ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new Error('drop-job runs dir must be an absolute path');
  return resolve(dir);
}

/** Lexical containment: `resolve` must keep the candidate under `root`. */
function inside(root: string, ...segments: string[]): string {
  const base = resolve(root);
  const candidate = resolve(base, ...segments);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new DropJobPathError(candidate);
  }
  return candidate;
}

const enoent = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Symlink-aware resolve of a path that may not exist: realpath the deepest
 * existing ancestor, then append the missing tail. Used for the root itself so
 * a missing root under a symlinked parent still compares equal to candidates.
 */
async function realResolve(path: string): Promise<string> {
  let probe = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(probe);
      return tail.length === 0 ? resolved : join(resolved, ...tail);
    } catch (e) {
      if (!enoent(e)) throw e;
      const parent = dirname(probe);
      if (parent === probe) throw e;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Physical containment: lexical check plus a symlink-aware resolve of the
 * deepest existing ancestor, so `leader/drop` or `queue` replaced by a symlink
 * to outside the root is refused even when the leaf does not exist yet. A
 * missing root falls back to its resolved spelling — nothing can symlink-escape
 * a directory that does not exist.
 */
async function realInside(root: string, ...segments: string[]): Promise<string> {
  const lexical = inside(root, ...segments);
  const base = await realResolve(root);
  const resolved = await realResolve(lexical);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new DropJobPathError(resolved);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** `#job repo=phantom lane=<lane> tier=<tier>` — ingest demands this as line 1. */
export function dropJobHeader(lane: string, tier: string): string {
  return `#job repo=phantom lane=${lane} tier=${tier}`;
}

/** Header line, blank line, body, trailing newline — the on-disk shape. */
export function composeDropJobFile(input: Pick<DropJobInput, 'lane' | 'tier' | 'body'>): string {
  return `${dropJobHeader(input.lane, input.tier)}\n\n${input.body}\n`;
}

/**
 * Mirrors the ingest's accept list. Every failure names a machine reason:
 * `id-shape`, `lane`, `tier`, `empty-body`, `control-characters`,
 * `denied-content`, `too-large`.
 */
export function validateDropJob(input: { id: unknown; lane: unknown; tier: unknown; body: unknown }): DropJobValidation {
  const reasons: string[] = [];
  if (typeof input.id !== 'string' || !DROP_JOB_ID.test(input.id)) reasons.push('id-shape');
  if (typeof input.lane !== 'string' || !LANES.has(input.lane)) reasons.push('lane');
  if (typeof input.tier !== 'string' || !TIERS.has(input.tier)) reasons.push('tier');
  const body = input.body;
  if (typeof body !== 'string' || body.trim() === '') {
    reasons.push('empty-body');
  } else {
    if (CONTROL_BESIDES_NL_TAB.test(body)) reasons.push('control-characters');
    if (DENIED_CONTENT.test(body)) reasons.push('denied-content');
  }
  if (typeof input.lane === 'string' && typeof input.tier === 'string' && typeof body === 'string'
    && Buffer.byteLength(composeDropJobFile({ lane: input.lane, tier: input.tier, body }), 'utf8') > DROP_JOB_MAX_FILE_BYTES) {
    reasons.push('too-large');
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Exists / queue depth
// ---------------------------------------------------------------------------

/**
 * True when `id` is already spent anywhere the ingest tracks it: still in the
 * drop lane, done, accepted into `queue/prompts`, or launched (the
 * `RQ-PHX-<id>.prompt` file at the runs root).
 */
export async function dropJobExists(root: string, id: string): Promise<boolean> {
  if (!DROP_JOB_ID.test(id)) return false;
  const name = `${DROP_JOB_FILE_PREFIX}${id}.md`;
  const candidates = [
    ['leader', 'drop', 'claude', name],
    ['leader', 'drop', 'done', name],
    ['queue', 'prompts', name],
    [`${DROP_JOB_FILE_PREFIX}${id}.prompt`],
  ];
  for (const segments of candidates) {
    let path: string;
    try {
      path = await realInside(root, ...segments);
    } catch (e) {
      if (enoent(e)) continue;
      throw e;
    }
    try {
      await lstat(path);
      return true;
    } catch (e) {
      if (!enoent(e)) throw e;
    }
  }
  return false;
}

/** RQ-PHX prompt files waiting in `queue/prompts` — the 507 backpressure signal. */
export async function countQueuedDropJobPrompts(root: string): Promise<number> {
  let dir: string;
  try {
    dir = await realInside(root, 'queue', 'prompts');
  } catch (e) {
    if (enoent(e)) return 0;
    throw e;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (enoent(e)) return 0;
    throw e;
  }
  return entries.filter((entry) => entry.isFile() && DROP_JOB_FILE.test(entry.name)).length;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Compose and publish `RQ-PHX-<id>.md` into `leader/drop/claude`. Atomic:
 * the body lands in a dot-prefixed sibling temp file first, then link(2)
 * publishes it — failing DropJobExistsError when the id is already taken —
 * and the temp is always unlinked. Re-validates the input itself so no caller
 * can skip the contract. `now` is the timestamp seam for tests.
 */
export async function writeDropJob(
  root: string,
  input: DropJobInput,
  now: () => Date = () => new Date(),
): Promise<DropJobWritten> {
  const validation = validateDropJob(input);
  if (!validation.ok) throw new DropJobValidationError(validation.reasons);
  const name = `${DROP_JOB_FILE_PREFIX}${input.id}.md`;
  const dir = await realInside(root, 'leader', 'drop', 'claude');
  await mkdir(dir, { recursive: true });
  // mkdir could not make an existing symlink safe: re-prove containment on the
  // now-materialized directory before publishing into it.
  const materialized = await realInside(root, 'leader', 'drop', 'claude');
  const content = composeDropJobFile(input);
  const temp = join(materialized, `.${name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await link(temp, join(materialized, name));
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DropJobExistsError(input.id);
    }
    throw e;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  const file = join(materialized, name);
  return { file, bytes: Buffer.byteLength(content, 'utf8'), at: now().toISOString() };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function clipTitle(text: string): string {
  const clean = scrubSecrets(text).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > TITLE_CHARS ? `${clean.slice(0, TITLE_CHARS - 1)}…` : clean;
}

/**
 * The jobs waiting in `leader/drop/claude`, name-sorted — the same order the
 * sweep reads. `title` is the first non-empty body line (120 chars, scrubbed);
 * a file that cannot be read still lists, with its parsed fields null.
 */
export async function listDropJobs(root: string, now: () => number = Date.now): Promise<DropJobListItem[]> {
  let dir: string;
  try {
    dir = await realInside(root, 'leader', 'drop', 'claude');
  } catch (e) {
    if (enoent(e)) return [];
    throw e;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (enoent(e)) return [];
    throw e;
  }
  const items: DropJobListItem[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const match = DROP_JOB_FILE.exec(entry.name);
    if (!match) continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      continue; // swept between the listing and now — it is not waiting any more
    }
    if (!stat.isFile()) continue;
    let lane: string | null = null;
    let tier: string | null = null;
    let title: string | null = null;
    try {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, LIST_READ_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
        const header = HEADER_LINE.exec(lines[0] ?? '');
        if (header) {
          lane = header[1]!;
          tier = header[2]!;
        }
        // Line 1 is the header only when it parses — otherwise it is content.
        const firstBody = lines.slice(header ? 1 : 0).find((line) => line.trim() !== '');
        if (firstBody !== undefined) title = clipTitle(firstBody);
      } finally {
        await handle.close();
      }
    } catch {
      // Unreadable: still listed — it is sitting in the sweep's way.
    }
    items.push({
      id: match[1]!,
      lane,
      tier,
      title,
      bytes: stat.size,
      ageSeconds: Math.max(0, Math.floor((now() - stat.mtimeMs) / 1000)),
    });
  }
  return items;
}
