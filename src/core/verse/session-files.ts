/**
 * core/verse/session-files.ts — the Files pane's directory browser and file
 * preview: bounded, READ-ONLY fs/promises access inside a chat's own roots.
 *
 * Sibling of resources/console-files.ts, which does the same job for the
 * resource console's registered projects — same deny intent (no dotfiles but
 * a small safe set, no credential- or key-shaped names, no build output), same
 * bounded answers (256 entries, a 64 KiB text preview). The differences are
 * deliberate:
 *
 *   - ASYNC. Verse route code never makes a synchronous filesystem call into
 *     an operator folder (folder-io.ts; scripts/check-verse-sync-io.mjs), so
 *     every stat, open and read here is fs/promises behind withFolderIo. A
 *     pending macOS privacy prompt parks a pool thread, never the server.
 *   - SESSION ROOTS, not registered projects. The allowed set is the chat's
 *     own `verseSessionRoots`, each re-validated per request by
 *     checkWorkspaceRootPathAsync (a root deleted or forbidden since the chat
 *     began is simply not browsable). A requested `root` must name one of
 *     them by PHYSICAL path, and every browsed path must realpath back inside
 *     it — a symlinked spelling of a root is the same root, a symlink out of
 *     it is not (the terminal's resolveCwdWithin rule).
 *   - No project-identity pinning. console-files re-proves a registered
 *     binding's dev/ino on every call because its catalog is persistent;
 *     here the containment proof is the realpath check plus O_NOFOLLOW opens,
 *     which is what the per-request root validation already buys.
 *
 * The file checks are a preview's, not a vault's: regular file, not a
 * symlink, owned by this user, sane size, valid UTF-8 text without control
 * characters. Group/other-writable bits and hardlink counts are NOT required
 * (a umask-002 checkout is full of 0664 files the operator reads daily, and
 * the preview reads the inode the open pinned — a swapped path cannot change
 * what was read). Every response still passes sendJson → sanitizePublicJson,
 * which scrubs secret-shaped strings and rewrites home to `~`.
 */
import { constants } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { mapLimited, withFolderIo } from './folder-io.js';
import {
  checkWorkspaceRootPathAsync,
  expandHomePrefix,
  isUnderPath,
  physicalPathAsync,
} from './path-guard.js';
import { verseSessionRoots } from './types.js';
import type {
  VerseFileBrowseEntry,
  VerseFileBrowseResponse,
  VerseFileReadResponse,
} from './workbench-types.js';

/** One directory listing is capped here — same bound as the resource console's. */
export const VERSE_FILE_BROWSE_MAX_ENTRIES = 256;
/** A preview reads at most this many bytes; larger files answer `truncated`. */
export const VERSE_FILE_READ_MAX_BYTES = 64 * 1024;
/** Longest root-relative path either route accepts. */
const MAX_RELATIVE_PATH_BYTES = 4096;
/** Entry-name stat fan-out inside one listing. */
const ENTRY_STAT_CONCURRENCY = 8;

/** Names that are never listed or opened, whatever they contain. */
const DENIED = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'coverage', 'target',
  'credentials', 'credentials.json', 'secrets', 'secrets.json', 'auth.json', 'tokens.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'service-account.json',
]);
/** Hidden names allowed through: project plumbing, never user secrets. */
const SAFE_HIDDEN = new Set(['.github', '.gitignore', '.gitattributes', '.editorconfig']);

export type SessionFilesErrorCode = 'INVALID' | 'NOT_FOUND' | 'UNAVAILABLE' | 'LIMIT';
export class SessionFilesError extends Error {
  constructor(
    readonly code: SessionFilesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionFilesError';
  }
}

function hasControl(text: string, allowWhitespace = false): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && !(allowWhitespace && [9, 10, 13].includes(code)) || code >= 127 && code <= 159;
  });
}

function allowedName(name: string): boolean {
  const key = name.normalize('NFC').toLowerCase();
  return name.length > 0 && Buffer.byteLength(name) <= 255 && (!name.startsWith('.') || SAFE_HIDDEN.has(key)) &&
    !/[\\/]/u.test(name) && !hasControl(name) &&
    Buffer.from(name).toString('utf8') === name && !DENIED.has(key) &&
    !/\.(pem|key|p12|pfx|keystore)$/u.test(key);
}

/**
 * A `/`-joined relative path → its segments, each name-policy checked.
 * `directory` permits the empty path (the root itself); a file path may not
 * be empty. `.`/`..` fail allowedName, so traversal cannot be spelled.
 */
function relativeSegments(path: unknown, directory: boolean): string[] {
  if (typeof path !== 'string' || Buffer.byteLength(path) > MAX_RELATIVE_PATH_BYTES ||
    !directory && path === '' || path !== '' && !path.split('/').every(allowedName)) {
    throw new SessionFilesError('INVALID', 'Use an allowed chat-root-relative path.');
  }
  return path === '' ? [] : path.split('/');
}

/** The session fields browsing needs — its configured roots, nothing else. */
export type SessionFilesSession = Parameters<typeof verseSessionRoots>[0];

/**
 * The chat's browsable roots, re-validated NOW: each stored root must still
 * pass the workspace-root guard (never `/`, `~`, `~/.ashlr`, codex artifacts)
 * and still be a directory. Physical-or-lexical resolved paths, deduped.
 */
async function browsableRoots(session: SessionFilesSession): Promise<string[]> {
  const checks = await Promise.all(
    verseSessionRoots(session).map((root) => withFolderIo(() => checkWorkspaceRootPathAsync(root))),
  );
  const out: string[] = [];
  for (const check of checks) {
    if (check.ok && !out.includes(check.path)) out.push(check.path);
  }
  return out;
}

/**
 * The root a request names, or the chat's primary. Absent → first browsable
 * root. Present → expandHomePrefix, re-run the guard, and require the PHYSICAL
 * result to be one of the chat's browsable roots (a symlinked spelling of a
 * root is the same root; anything else is refused).
 */
async function resolveRoot(session: SessionFilesSession, raw: string | undefined): Promise<{ root: string; roots: string[] }> {
  const roots = await browsableRoots(session);
  if (raw === undefined) {
    const primary = roots[0];
    if (!primary) throw new SessionFilesError('UNAVAILABLE', "this chat's folder is no longer available");
    return { root: primary, roots };
  }
  const checked = await withFolderIo(() => checkWorkspaceRootPathAsync(expandHomePrefix(raw)));
  if (!checked.ok) throw new SessionFilesError('INVALID', checked.error);
  if (!roots.includes(checked.path)) {
    throw new SessionFilesError('INVALID', "root must be one of this chat's folders");
  }
  return { root: checked.path, roots };
}

/**
 * `join(root, ...segments)` proven to stay inside `root`: the target's
 * physical path must equal the root's or sit under it. Returns the lexical
 * target for the caller's own lstat/open (both of which refuse symlinks at
 * the leaf), or throws NOT_FOUND when the path does not resolve.
 */
async function containedTarget(root: string, segments: string[]): Promise<{ target: string; physicalRoot: string }> {
  const physicalRoot = await withFolderIo(() => physicalPathAsync(root));
  if (!physicalRoot) throw new SessionFilesError('UNAVAILABLE', "this chat's folder is no longer available");
  const target = join(root, ...segments);
  const physical = await withFolderIo(() => physicalPathAsync(target));
  if (!physical) throw new SessionFilesError('NOT_FOUND', 'path was not found');
  if (!isUnderPath(physical, physicalRoot)) {
    throw new SessionFilesError('INVALID', 'path must stay inside the chat folder');
  }
  return { target, physicalRoot };
}

function translate(error: unknown): never {
  if (error instanceof SessionFilesError) throw error;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    throw new SessionFilesError('NOT_FOUND', 'path was not found');
  }
  throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');
}

export interface SessionFilesTarget {
  session: SessionFilesSession;
  root?: string;
}

/** POST /api/verse/files/browse — one directory listing inside a chat root. */
export async function browseSessionFiles(
  target: SessionFilesTarget,
  relPath: string | undefined,
): Promise<Omit<VerseFileBrowseResponse, 'sessionId'>> {
  try {
    const segments = relativeSegments(relPath ?? '', true);
    const { root } = await resolveRoot(target.session, target.root);
    const { target: dir } = await containedTarget(root, segments);
    const before = await withFolderIo(() => lstat(dir));
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new SessionFilesError('INVALID', 'path is not a directory');
    }

    // Bounded iteration: stop one past the cap so an oversized directory is a
    // LIMIT answer, not a silently truncated one (console-files' rule). `seen`
    // counts every dirent, filtered or not — a dir of dotfiles still overflows.
    const names: string[] = [];
    let seen = 0;
    const handle = await withFolderIo(() => opendir(dir));
    try {
      for (;;) {
        const entry = await handle.read();
        if (entry === null) break;
        if (++seen > VERSE_FILE_BROWSE_MAX_ENTRIES) {
          throw new SessionFilesError('LIMIT', `Directory exceeds the ${VERSE_FILE_BROWSE_MAX_ENTRIES}-entry browsing limit.`);
        }
        if (allowedName(entry.name) && !entry.isSymbolicLink()) names.push(entry.name);
      }
    } finally {
      await handle.close();
    }
    // opendir follows a swapped symlink where lstat refused one: re-prove the
    // path still names the directory that was checked before answering.
    const afterDir = await withFolderIo(() => lstat(dir));
    if (!afterDir.isDirectory() || afterDir.isSymbolicLink() ||
      afterDir.dev !== before.dev || afterDir.ino !== before.ino) {
      throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');
    }

    const entries = await mapLimited(names, ENTRY_STAT_CONCURRENCY, async (name): Promise<VerseFileBrowseEntry | null> => {
      try {
        const child = join(dir, name);
        const stat = await withFolderIo(() => lstat(child));
        const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
        if (kind === null) return null;
        return {
          name,
          path: [...segments, name].join('/'),
          kind,
          sizeBytes: kind === 'file' ? Number(stat.size) : null,
        };
      } catch {
        // The agent mutates the tree while it is browsed: an entry that
        // vanished (or turned unreadable) between readdir and lstat is
        // simply not listed — it still counted toward the entry cap.
        return null;
      }
    });
    const kept = entries.filter((e): e is VerseFileBrowseEntry => e !== null);
    kept.sort((a, b) => a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'directory' ? -1 : 1);
    return { root, path: segments.join('/'), entries: kept };
  } catch (error) {
    return translate(error);
  }
}

/** POST /api/verse/files/read — a bounded UTF-8 preview of one file in a chat root. */
export async function readSessionFile(
  target: SessionFilesTarget,
  relPath: string,
): Promise<Omit<VerseFileReadResponse, 'sessionId'>> {
  let handle: FileHandle | undefined;
  try {
    const segments = relativeSegments(relPath, false);
    const { root } = await resolveRoot(target.session, target.root);
    const { target: file } = await containedTarget(root, segments);

    const before = await withFolderIo(() => lstat(file));
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SessionFilesError('INVALID', 'path is not a file');
    }
    handle = await withFolderIo(() =>
      open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');
    }
    if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
      throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');
    }
    const sizeBytes = Number(opened.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');
    }
    const raw = Buffer.alloc(Math.min(sizeBytes, VERSE_FILE_READ_MAX_BYTES));
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
      if (bytesRead === 0) {
        throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');
      }
      offset += bytesRead;
    }
    // The opened inode is what was read; re-prove the path still names it and
    // still sits inside the root before answering.
    const after = await withFolderIo(() => lstat(file));
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');
    }
    const { target: still } = await containedTarget(root, segments);
    if (still !== file) throw new SessionFilesError('UNAVAILABLE', 'project file is unsafe, changed, or unavailable');

    const truncated = sizeBytes > raw.length;
    // Streaming decode permits only an incomplete final code point at a preview boundary.
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw, { stream: truncated });
    } catch {
      throw new SessionFilesError('INVALID', 'File preview must be valid UTF-8 text.');
    }
    if (hasControl(text, true)) {
      throw new SessionFilesError('INVALID', 'Binary or control-character file previews are not supported.');
    }
    return {
      root,
      path: segments.join('/'),
      text,
      sizeBytes,
      byteLength: Buffer.byteLength(text),
      truncated,
    };
  } catch (error) {
    return translate(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}
