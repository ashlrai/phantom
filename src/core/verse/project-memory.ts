/**
 * Shared project memory — one private directory per project that EVERY seat
 * working on that project reads (and, where the CLI can be granted a writable
 * root, maintains):
 *
 *   <verse root>/memory/<basename-slug>-<sha256(realpath)[0:12]>/MEMORY.md
 *   (default verse root: ~/.ashlr/verse — dir 0700, files 0600)
 *
 * WHY VERSE OWNS IT rather than each CLI's native memory: every seat runs in an
 * isolated home (`native-profiles/<seat>/native-state`), so Claude's auto
 * memory, Codex's `memories` and Grok's `memory/` are per ACCOUNT, and none of
 * them crosses engines. A plain Markdown file in a directory Verse controls is
 * the one surface all four engines can be pointed at, costs nothing (no
 * background extraction model runs — those spend automatically), and stays
 * OUTSIDE the repository, so nothing an agent writes here lands in a diff.
 * (docs/VERSE-CONTEXT.md, research frontier-native-memory.)
 *
 * HOW A SESSION SEES IT: `prepareProjectMemory` returns `{dir, block,
 * writable}`, which the API snapshots into the private launch record at
 * creation. The adapters send the SAME `block` on every turn (claude/local:
 * `--append-system-prompt`; codex/grok per their adapters) — byte-identical, so
 * the provider's prompt cache survives turn after turn. The block carries the
 * MEMORY.md of the moment the chat began; agents that can reach `dir` read the
 * live file for anything newer.
 *
 * SAFETY
 *  - The directory key is a hash of the canonical path, so two projects with
 *    the same basename never share memory and a path cannot traverse out.
 *  - MEMORY.md is read without following symlinks: an agent that replaced it
 *    with a link to ~/.ssh/id_ed25519 would otherwise have that file echoed to
 *    the UI and into every future system prompt.
 *  - The block is `scrubSecrets`'d and capped at VERSE_MEMORY_BLOCK_MAX_BYTES.
 *    The instructions tell agents never to store secrets; the scrub is the
 *    backstop, not the policy.
 *  - The block is ARGV-SAFE: C0/C1 control characters (NUL above all) are
 *    stripped. The block rides on argv (`--append-system-prompt=…`,
 *    `--rules=…`) and Node's spawn throws ERR_INVALID_ARG_VALUE for any argv
 *    element containing NUL. Agents write MEMORY.md directly (not through
 *    `writeProjectMemory`'s NUL check), and the block is pinned into the
 *    launch record — so one stray NUL would otherwise make every new chat in
 *    the project unable to start, permanently.
 *
 * Spends nothing and starts no process.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';

import {
  canonicalProjectPath,
  defaultVerseRoot,
  ensurePrivateDirectory,
  loadVersePreferences,
  memoryEnabledFor,
  readPrivateFileCapped,
  utf8Prefix,
  VerseServiceError,
  writePrivateFileAtomic,
} from './preferences.js';
import { VERSE_MEMORY_BLOCK_MAX_BYTES, VERSE_MEMORY_MAX_BYTES, type VerseProjectMemory } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VERSE_MEMORY_DIRNAME = 'memory';
export const VERSE_MEMORY_FILE = 'MEMORY.md';
/** Hard cap on the system-prompt block, instructions included. */
export { VERSE_MEMORY_BLOCK_MAX_BYTES }; // defined in types.ts so the browser mirrors it exactly
/** Longest MEMORY.md the UI is shown; agents can outgrow the write cap, and a view must not truncate silently below it. */
const MEMORY_READ_CAP_BYTES = 4 * VERSE_MEMORY_MAX_BYTES;
/** Names listed from the memory directory. */
const MAX_LISTED_FILES = 200;
const SLUG_MAX_CHARS = 40;
/** Marker appended where the snapshot in the block was cut. */
export const VERSE_MEMORY_TRUNCATION_MARKER = `[… ${VERSE_MEMORY_FILE} continues — read the file for the rest]`;

// ---------------------------------------------------------------------------
// Locating a project's memory
// ---------------------------------------------------------------------------

function slugOf(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'project';
}

/**
 * The memory directory for a project. Pure path arithmetic (no I/O beyond the
 * realpath canonicalisation); does not create anything.
 *
 * @param root the Verse store root (default `~/.ashlr/verse`), the same root
 *             the session engine and preferences use.
 */
export function projectMemoryDir(projectPath: string, root: string = defaultVerseRoot()): string {
  const canonical = canonicalProjectPath(projectPath);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return join(root, VERSE_MEMORY_DIRNAME, `${slugOf(basename(canonical))}-${hash}`);
}

// ---------------------------------------------------------------------------
// The system-prompt block
// ---------------------------------------------------------------------------

/**
 * Every C0 control except TAB (\x09) and LF (\x0A), plus DEL and the C1 range.
 * CR is included: callers normalise CRLF to LF first, and a lone CR left in a
 * system prompt only garbles how the text renders.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Text made safe to pass as (part of) an argv element and to show as prose:
 * CRLF → LF, then every control character except `\n` and `\t` removed.
 * Exported so the engine can repair a snapshot pinned before this existed
 * (a launch record carrying a NUL must be healed, not rejected — rejecting it
 * would brick the session it belongs to).
 */
export function stripUnsafeControlChars(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE_CONTROL_CHARS, '');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Cut `text` to at most `maxBytes`, preferring a line boundary, never splitting a character. */
function cutToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const prefix = utf8Prefix(Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes)));
  const lastNewline = prefix.lastIndexOf('\n');
  // Only back up to a line boundary when that keeps most of the budget.
  return lastNewline >= prefix.length * 0.6 ? prefix.slice(0, lastNewline) : prefix;
}

// ---------------------------------------------------------------------------
// Stale path references
// ---------------------------------------------------------------------------

/**
 * A repository path written in a memory line: at least two segments, made of
 * the characters real paths use. Prose like "and/or" or "CI/CD" matches too;
 * {@link isCheckablePath} keeps only references whose first segment exists in
 * the project, so those are never checked.
 */
const PATH_REFERENCE = /(?:^|[\s`'"([])((?:\.\/)?[A-Za-z0-9_@][A-Za-z0-9_@.-]*(?:\/[A-Za-z0-9_@.-]+)+\/?)/g;
/** A markdown link target: the index links its detail files this way. */
const LINK_TARGET = /\]\(([^()\s#?]+)(?:#[^()\s]*)?\)/g;
/** Build output and installed packages: absent from a clean checkout without anything being stale. */
const GENERATED_SEGMENT = /(?:^|\/)(?:node_modules|target|dist|build|out|coverage|\.next|gen)(?:\/|$)/;
/** At most this many references are checked per MEMORY.md, so a huge file costs a bounded number of stats. */
const MAX_PATH_CHECKS = 300;
/** At most this many missing references are named on one line. */
const MAX_MISSING_PER_LINE = 3;

/** `src/a.ts:42`, `src/a.ts:42:7` and a trailing `.`/`,` are the same reference as `src/a.ts`. */
function trimReference(raw: string): string {
  return raw.replace(/(?::\d+){1,2}$/, '').replace(/[.,;:]+$/, '').replace(/^\.\//, '').replace(/\/$/, '');
}

/**
 * Whether `path` names something inside `base` that exists right now. A
 * reference that climbs out of `base` is never probed. `lstat`, so a symlink
 * counts as present without being followed.
 */
function existsUnder(base: string, path: string): boolean {
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(base + sep)) return true;
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The checker {@link prepareProjectMemory} hands to {@link renderMemoryBlock}:
 * a path reference is missing when its first segment exists at the project
 * root (so it really is a repository path) but the path itself does not. A
 * markdown link to a detail file is missing when neither the memory directory
 * nor the project has it.
 */
export function memoryPathChecker(projectRoot: string, memoryDir: string): MemoryPathChecker {
  const firstSegments = new Map<string, boolean>();
  const isCheckablePath = (ref: string): boolean => {
    const first = ref.split('/')[0] ?? '';
    if (first === '' || first === '..') return false;
    let present = firstSegments.get(first);
    if (present === undefined) {
      present = existsUnder(projectRoot, first);
      firstSegments.set(first, present);
    }
    return present;
  };
  return {
    pathMissing: (ref) => isCheckablePath(ref) && !existsUnder(projectRoot, ref),
    linkMissing: (ref) => !existsUnder(memoryDir, ref) && !existsUnder(projectRoot, ref),
  };
}

export interface MemoryPathChecker {
  /** A repository path reference (`src/core/x.ts`) that is gone. */
  pathMissing(ref: string): boolean;
  /** A relative markdown link target (`](debugging.md)`) that is gone. */
  linkMissing(ref: string): boolean;
}

/** The note appended to a memory line that cites paths missing when the chat began. */
export function staleReferenceNote(missing: readonly string[]): string {
  return ` (stale? not in the project now: ${missing.map((ref) => `\`${ref}\``).join(', ')})`;
}

/**
 * Mark each memory line that cites a path that no longer exists. A memory
 * that names a deleted or renamed file sends the agent to read the wrong
 * thing, and the fact around it is the most likely to be out of date; the
 * note keeps the fact but says what to verify. Returns the text and whether
 * any line was marked.
 */
export function markStaleReferences(text: string, checker: MemoryPathChecker): { text: string; marked: number } {
  let checks = 0;
  let marked = 0;
  const lines = text.split('\n').map((line) => {
    const missing: string[] = [];
    const consider = (ref: string, isMissing: (r: string) => boolean): void => {
      if (ref.length === 0 || ref.includes('://') || missing.includes(ref) || checks >= MAX_PATH_CHECKS) return;
      checks += 1;
      if (isMissing(ref)) missing.push(ref);
    };
    const links = new Set<string>();
    for (const match of line.matchAll(LINK_TARGET)) {
      const target = match[1] ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
      const ref = trimReference(target);
      links.add(ref);
      consider(ref, checker.linkMissing);
    }
    // Strip URLs first so their paths are never read as repository paths.
    const prose = line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
    for (const match of prose.matchAll(PATH_REFERENCE)) {
      const raw = match[1] ?? '';
      const after = prose.charAt((match.index ?? 0) + match[0].length);
      // `test/h*.test.ts`, `CONTRACT-M<N>.md`, `{a,b}`: a pattern, not a path.
      if (/[*<{$[%]/.test(after)) continue;
      const ref = trimReference(raw);
      if (!ref.includes('/') || links.has(ref) || GENERATED_SEGMENT.test(ref)) continue;
      // Without an extension, "test/release-authoring helper" is as likely
      // prose as a directory; only a quoted or slash-terminated one is a path.
      const hasExtension = /\.[A-Za-z0-9]+$/.test(ref.slice(ref.lastIndexOf('/') + 1));
      if (!hasExtension && !match[0].startsWith('`') && !raw.endsWith('/')) continue;
      consider(ref, checker.pathMissing);
    }
    if (missing.length === 0) return line;
    marked += 1;
    return `${line}${staleReferenceNote(missing.slice(0, MAX_MISSING_PER_LINE))}`;
  });
  return { text: lines.join('\n'), marked };
}

/**
 * The fixed instructions. SHORT and DIRECTIVE on purpose: it rides on every
 * turn's system prompt, so each sentence is paid for again and again (cheaply,
 * from cache — which is why it must never vary between turns of one chat).
 */
function memoryInstructions(dir: string, projectName: string, writable: boolean, staleMarked = false): string {
  const file = join(dir, VERSE_MEMORY_FILE);
  const lines = [
    '# Shared project memory (Phantom)',
    '',
    `Every AI seat that works on "${projectName}" shares one memory directory, kept outside the repository:`,
    `  ${dir}`,
    `Its index is ${file}.`,
    '',
  ];
  if (writable) {
    lines.push(
      `- Before substantial work, read ${VERSE_MEMORY_FILE}: the file on disk may be newer than the snapshot below.`,
      `- Keep ${VERSE_MEMORY_FILE} a concise index (at most 200 lines) of DURABLE facts, each with its reason: decisions and why they were made, conventions, gotchas, and the status of the current plan. Put detail in other files in the same directory and link them from the index.`,
      '- Update it at milestones (a decision made, a plan step finished, a gotcha found), not after every edit. Edit in place and delete facts that are no longer true.',
      '- Never store secrets, credentials, tokens or personal data there.',
    );
  } else {
    lines.push(
      '- This seat may only READ the memory: rely on the snapshot below (and the directory, if your tools can reach it). Do not try to write there.',
      '- If you learn something durable — a decision and its reason, a convention, a gotcha, plan status — say so in your reply so it can be recorded.',
      '- Never repeat secrets, credentials, tokens or personal data from it.',
    );
  }
  if (staleMarked) {
    lines.push(
      writable
        ? '- Lines marked "(stale? …)" cite paths missing when this chat began: verify them before relying on the fact, then fix or delete the line.'
        : '- Lines marked "(stale? …)" cite paths missing when this chat began: treat those facts as possibly out of date.',
    );
  }
  lines.push('', `## ${VERSE_MEMORY_FILE} when this chat began`, '');
  return lines.join('\n');
}

/**
 * Deterministic: the same (dir, content, writable) always yields the same
 * bytes, so a block snapshotted into a launch record keeps the prompt prefix
 * cache-stable for the whole conversation.
 */
export function renderMemoryBlock(input: {
  dir: string;
  projectName: string;
  content: string;
  writable: boolean;
  /** When given, lines citing paths that are gone are marked (see {@link markStaleReferences}). */
  paths?: MemoryPathChecker;
}): string {
  // Strip BEFORE scrubbing and trimming, so a control byte can neither split a
  // secret the scrubber would have matched nor survive at an edge.
  let body = scrubSecrets(stripUnsafeControlChars(input.content)).trim();
  let marked = 0;
  if (input.paths && body.length > 0) ({ text: body, marked } = markStaleReferences(body, input.paths));
  // The project name is a directory basename: legal on disk with control
  // bytes in it, never legal on argv with a NUL. `dir` is a real path (no NUL
  // possible) and must stay byte-exact, so it is left alone.
  const head = memoryInstructions(input.dir, stripUnsafeControlChars(input.projectName), input.writable, marked > 0);
  if (body.length === 0) {
    return cutToBytes(`${head}(empty — nothing recorded yet)`, VERSE_MEMORY_BLOCK_MAX_BYTES);
  }
  const budget = VERSE_MEMORY_BLOCK_MAX_BYTES - byteLength(head);
  if (byteLength(body) <= budget) return `${head}${body}`;
  const room = budget - byteLength(`\n${VERSE_MEMORY_TRUNCATION_MARKER}`);
  if (room <= 0) return cutToBytes(head, VERSE_MEMORY_BLOCK_MAX_BYTES);
  return `${head}${cutToBytes(body, room).trimEnd()}\n${VERSE_MEMORY_TRUNCATION_MARKER}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function ensureMemoryDir(dir: string, root: string): void {
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(join(root, VERSE_MEMORY_DIRNAME));
  ensurePrivateDirectory(dir);
}

/** MEMORY.md, safely: regular file only, never through a symlink. */
function readMemoryFile(dir: string): { text: string; bytes: number; mtimeMs: number } | null {
  const file = readPrivateFileCapped(join(dir, VERSE_MEMORY_FILE), MEMORY_READ_CAP_BYTES);
  return file ? { text: file.text, bytes: file.bytes, mtimeMs: file.mtimeMs } : null;
}

/** Everything else the agents keep beside MEMORY.md (names only; dirs end in '/'). */
function listOtherFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (out.length >= MAX_LISTED_FILES) break;
    if (name === VERSE_MEMORY_FILE) continue;
    // Our own atomic-write temporaries (and any other dot-temp) are not content.
    if (name.startsWith('.') && name.endsWith('.tmp')) continue;
    try {
      const stat = lstatSync(join(dir, name));
      if (stat.isDirectory()) out.push(`${name}/`);
      else if (stat.isFile()) out.push(name);
      // Symlinks, sockets, fifos are not listed: nothing here should be one.
    } catch {
      // Vanished between readdir and lstat.
    }
  }
  return out;
}

/**
 * Create the project's memory directory (0700) and render the block a new
 * session will carry. Called once, at session creation; the result is pinned
 * in the launch record (`VerseSeatLaunch.memory`).
 *
 * `writable` is the SEAT's capability, decided by the caller from the engine:
 * claude/local (`--add-dir`) and codex (writable root) can write; grok, which
 * reaches only its `--cwd`, cannot.
 */
export function prepareProjectMemory(
  projectPath: string,
  opts: { writable: boolean; root?: string },
): { dir: string; block: string; writable: boolean } {
  const root = opts.root ?? defaultVerseRoot();
  const canonical = canonicalProjectPath(projectPath);
  const dir = projectMemoryDir(canonical, root);
  ensureMemoryDir(dir, root);
  const current = readMemoryFile(dir);
  const block = renderMemoryBlock({
    dir,
    projectName: basename(canonical) || canonical,
    content: current?.text ?? '',
    writable: opts.writable,
    paths: memoryPathChecker(canonical, dir),
  });
  return { dir, block, writable: opts.writable };
}

/**
 * The project's memory as the UI shows it. Never creates anything; a project
 * with no memory yet reads as empty with `updatedAt: null`.
 *
 * `enabled` is passed in (the API resolves it from preferences) so this stays
 * a pure read of the directory.
 */
export function readProjectMemory(projectPath: string, enabled: boolean, root: string = defaultVerseRoot()): VerseProjectMemory {
  const canonical = canonicalProjectPath(projectPath);
  const dir = projectMemoryDir(canonical, root);
  let dirOk = false;
  try {
    const stat = lstatSync(dir);
    dirOk = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    return { projectPath: canonical, enabled, content: '', bytes: 0, updatedAt: null, files: [] };
  }
  const file = readMemoryFile(dir);
  return {
    projectPath: canonical,
    enabled,
    content: file?.text ?? '',
    bytes: file?.bytes ?? 0,
    updatedAt: file ? new Date(file.mtimeMs).toISOString() : null,
    files: listOtherFiles(dir),
  };
}

/**
 * Replace MEMORY.md with the operator's text (atomic, 0600). An empty string
 * clears it. Rejects content over VERSE_MEMORY_MAX_BYTES (VERSE_TOO_LARGE)
 * rather than truncating what the operator wrote, and NUL bytes (VERSE_INVALID).
 *
 * Allowed whether or not memory is enabled for the project — it is the
 * operator's own file — and `enabled` in the result reports the preference.
 */
export function writeProjectMemory(projectPath: string, content: string, root: string = defaultVerseRoot()): VerseProjectMemory {
  if (typeof content !== 'string') {
    throw new VerseServiceError('VERSE_INVALID', 'content must be a string');
  }
  if (content.includes('\0')) {
    throw new VerseServiceError('VERSE_INVALID', 'content must not contain NUL bytes');
  }
  const bytes = byteLength(content);
  if (bytes > VERSE_MEMORY_MAX_BYTES) {
    throw new VerseServiceError('VERSE_TOO_LARGE', `memory is ${bytes} bytes; the limit is ${VERSE_MEMORY_MAX_BYTES}`);
  }
  const canonical = canonicalProjectPath(projectPath);
  const dir = projectMemoryDir(canonical, root);
  ensureMemoryDir(dir, root);
  writePrivateFileAtomic(join(dir, VERSE_MEMORY_FILE), content);
  const enabled = memoryEnabledFor(loadVersePreferences(root), canonical);
  return readProjectMemory(canonical, enabled, root);
}
