/** Writer for `claim-thread-bindings.jsonl`, the claim → source Slack thread
 * map `runClaimNoticePass` reads (via `readClaimThreadBindings`) to decide
 * where ASSIGNED / RELEASED / BLOCKED / VERIFIED notices go. Before this
 * module nothing wrote that file, so every planned notice was dropped.
 *
 * Guarantees:
 *  - Every row written here round-trips through `readClaimThreadBindings`
 *    (same v1 shape, same bounds, threadKey in one of the two grammars the
 *    real sender parses).
 *  - The writer never pushes the file past the reader's own limits (4 MiB,
 *    5000 distinct claimId+repo pairs): crossing either makes the reader
 *    bind NOTHING, which would silently mute every thread. It refuses
 *    instead, and never throws.
 *  - Rows hold ids only — never message text, tokens or thread contents.
 *  - Append opens with O_NOFOLLOW at mode 0o600 inside a private (0700,
 *    owned, non-symlink) directory, so a planted link cannot redirect it. */
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { isSlackChannelId, isSlackTeamId, isSlackTs, parseSlackThreadRef } from '../agents/slack-network.js';
import type { ClaimThreadBinding } from './claim-thread-notice.js';
import { readClaimThreadBindings } from './claim-notice-send.js';
import { ensurePrivateDirectory, readPrivateFileCapped } from '../verse/preferences.js';

/** Must match `BINDINGS_MAX_BYTES` / `SNAPSHOT_MAX_ROWS` in claim-notice-send.ts. */
export const CLAIM_THREAD_BINDINGS_MAX_BYTES = 4 * 1024 * 1024;
export const CLAIM_THREAD_BINDINGS_MAX_PAIRS = 5000;

const PRINTABLE_ID = /^[\x21-\x7e]{1,128}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Exactly the two grammars `parseNoticeThreadRef` (src/cli/fleet-claim-notices.ts)
 * accepts: `slack:<team>:<channel>:<rootTs>` and `<team>/<channel>/<threadTs>`.
 * Reimplemented here because core must not import from src/cli. */
export function validateClaimThreadKey(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length > 256) return false;
  if (parseSlackThreadRef(ref) !== undefined) return true;
  const parts = ref.split('/');
  return parts.length === 3 && isSlackTeamId(parts[0]) && isSlackChannelId(parts[1]) && isSlackTs(parts[2]);
}

/** First validation failure as a stable reason, or null when the binding is writable. */
export function claimThreadBindingProblem(binding: ClaimThreadBinding): string | null {
  if (typeof binding.claimId !== 'string' || !PRINTABLE_ID.test(binding.claimId)) return 'invalid-claim-id';
  if (typeof binding.repo !== 'string' || !REPO.test(binding.repo)) return 'invalid-repo';
  if (!validateClaimThreadKey(binding.threadKey)) return 'invalid-thread';
  if (binding.pr !== undefined && !(Number.isSafeInteger(binding.pr) && binding.pr >= 0)) return 'invalid-pr';
  if (binding.head !== undefined && (typeof binding.head !== 'string' || !PRINTABLE_ID.test(binding.head))) {
    return 'invalid-head';
  }
  return null;
}

export type ClaimThreadBindResult =
  | { ok: true; status: 'bound' | 'rebound' | 'unchanged'; binding: ClaimThreadBinding }
  | { ok: false; kind: 'invalid' | 'refused'; reason: string };

const pairKey = (claimId: string, repo: string) => JSON.stringify([claimId, repo]);
const sameBinding = (a: ClaimThreadBinding, b: ClaimThreadBinding) =>
  a.claimId === b.claimId && a.repo === b.repo && a.threadKey === b.threadKey
  && a.pr === b.pr && a.head === b.head;

/** Append one v1 row binding `binding.claimId`+`binding.repo` to its source
 * thread. A row identical to the current winner is a no-op ('unchanged'). */
export function appendClaimThreadBinding(path: string, binding: ClaimThreadBinding, now: number): ClaimThreadBindResult {
  const problem = claimThreadBindingProblem(binding);
  if (problem !== null) return { ok: false, kind: 'invalid', reason: problem };
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, kind: 'invalid', reason: 'invalid-now' };
  const clean: ClaimThreadBinding = {
    claimId: binding.claimId, repo: binding.repo, threadKey: binding.threadKey,
    ...(binding.pr !== undefined ? { pr: binding.pr } : {}),
    ...(binding.head !== undefined ? { head: binding.head } : {}),
  };
  try {
    ensurePrivateDirectory(dirname(path));
  } catch {
    return { ok: false, kind: 'refused', reason: 'bindings-dir-unusable' };
  }
  const read = readPrivateFileCapped(path, CLAIM_THREAD_BINDINGS_MAX_BYTES);
  if (read?.truncated) return { ok: false, kind: 'refused', reason: 'bindings-over-budget' };
  // Loose pair count (any row naming a claimId+repo) so a near-cap file is
  // refused conservatively rather than tipped past the reader's limit.
  const pairs = new Set<string>();
  for (const line of read?.text.split('\n') ?? []) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.claimId === 'string' && typeof row.repo === 'string') pairs.add(pairKey(row.claimId, row.repo));
    } catch { /* A torn row has no countable pair; the sender refuses the file until repair. */ }
  }
  const key = pairKey(clean.claimId, clean.repo);
  const current = read === null ? undefined
    : readClaimThreadBindings(path).find(b => pairKey(b.claimId, b.repo) === key);
  if (current !== undefined && sameBinding(current, clean)) return { ok: true, status: 'unchanged', binding: clean };
  if (!pairs.has(key) && pairs.size >= CLAIM_THREAD_BINDINGS_MAX_PAIRS) {
    return { ok: false, kind: 'refused', reason: 'bindings-at-capacity' };
  }
  const row = `${JSON.stringify({ v: 1, ...clean, at: now })}\n`;
  // A torn final line would swallow this row into it: start on a fresh line.
  const prefix = read !== null && read.text.length > 0 && !read.text.endsWith('\n') ? '\n' : '';
  const bytes = Buffer.from(prefix + row, 'utf8');
  if ((read?.bytes ?? 0) + bytes.length > CLAIM_THREAD_BINDINGS_MAX_BYTES) {
    return { ok: false, kind: 'refused', reason: 'bindings-over-budget' };
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
  } catch {
    return { ok: false, kind: 'refused', reason: 'bindings-file-unusable' };
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, kind: 'refused', reason: 'bindings-file-unusable' };
    fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) return { ok: false, kind: 'refused', reason: 'bindings-write-failed' };
      offset += written;
    }
  } catch {
    return { ok: false, kind: 'refused', reason: 'bindings-write-failed' };
  } finally {
    closeSync(fd);
  }
  return { ok: true, status: current === undefined ? 'bound' : 'rebound', binding: clean };
}
