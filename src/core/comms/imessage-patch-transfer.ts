/**
 * RQ-SWE3-IMSGDEEP-1: chunked PATCH transfers from the personal Codex dot.
 *
 * The dot texts a patch as a sequence of protocol frames, one iMessage per
 * frame (iMessage bodies are size-limited, so a diff is chunked):
 *
 *   PATCH-BEGIN <id> <parts> <sha256>
 *   PATCH-PART <id> <i>/<parts>
 *   <chunk text — the remainder of the message after the first newline>
 *   PATCH-END <id> <sha256>
 *
 * <id> is a sender-chosen slug ([A-Za-z0-9][A-Za-z0-9._-]{0,63}); <sha256> is
 * the lowercase hex digest of the UTF-8 payload (every part's chunk bytes
 * concatenated in index order). BEGIN declares it, END repeats it, and both
 * must agree before any bytes are trusted.
 *
 *   parsePatchFrame(text)      - pure frame parser; null when not a frame,
 *     'malformed' when a PATCH marker does not parse.
 *   isPatchFrameText(text)     - cheap marker test shared with the findings
 *     bridge so protocol traffic is never mirrored as findings.
 *   recordPatchFrame(msg, o)   - consume one intake row if it is a frame;
 *     durable per-transfer state under <imessage>/patches/open/, sha256
 *     verified before <id>.patch is written beside <id>.receipt.json.
 *   sweepPatchTransfers(o)     - expire open transfers past the TTL and
 *     advance the watermark past their rows; runs once per poll.
 *   readPatchReceipts(o)       - bounded receipt listing for the findings
 *     bridge's artifact announcements.
 *
 * Frames are protocol traffic, not conversation: they are consumed here and
 * filtered out of the teammate.findings mirror. A completed transfer writes
 * an artifact only — nothing applies, stages or executes a patch. Frames that
 * can never assemble (malformed, secret-shaped, oversize, id reuse, part
 * conflict, hash mismatch) are terminal for their rowid: the dedup ring and
 * watermark record them once and no retry can resurrect them. Receipts carry
 * counts, ids and the hashed sender — never text or handles. Every entry
 * point never throws.
 */

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { imessageStateDir } from '../integrations/imessage.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';
import { isPatchFrameText, PATCH_FRAME_MARKERS, senderIdFor } from './imessage-teammate-inbox.js';

// The marker test lives in the leaf inbox module so read-only observers (the
// intent classifier there) never pull this module's fs/lock graph — importing
// it here would also close an import cycle. Re-exported to keep one surface.
export { isPatchFrameText };

// ---------------------------------------------------------------------------
// Protocol bounds
// ---------------------------------------------------------------------------

/** Most chunks in one transfer; an iMessage is small, so a patch is many parts. */
export const PATCH_MAX_PARTS = 64;
/** A single frame's text cap — anything larger cannot be protocol traffic. */
export const PATCH_FRAME_MAX = 16_384;
/** Reassembled payload cap; a texted patch is a review diff, not a snapshot. */
export const PATCH_PAYLOAD_MAX_BYTES = 512 * 1024;
/** Concurrent open transfers; a dot finishes a patch before starting another. */
export const PATCH_MAX_OPEN = 8;
/** An unfinished transfer this old is expired by the sweep, never completed. */
export const PATCH_TRANSFER_TTL_MS = 6 * 60 * 60 * 1000;
/** Dedup ring size: this many most-recent frame rowids are remembered. */
export const PATCH_HANDLED_MAX = 512;
/** Newest receipts the findings bridge scans per pass. */
export const PATCH_RECEIPT_SCAN_MAX = 64;

const PATCHES_DIR = 'patches';
const OPEN_DIR = 'open';
const STATE_FILE = 'state.json';
const LOCK_FILE = 'patch-transfer.lock';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const BEGIN_RE = /^PATCH-BEGIN (\S+) ([1-9][0-9]*) ([a-f0-9]{64})\s*$/;
const PART_RE = /^PATCH-PART (\S+) ([1-9][0-9]*)\/([1-9][0-9]*)$/;
const END_RE = /^PATCH-END (\S+) ([a-f0-9]{64})\s*$/;

// ---------------------------------------------------------------------------
// Frame parsing (pure)
// ---------------------------------------------------------------------------

export type PatchFrame =
  | { kind: 'begin'; id: string; parts: number; sha256: string }
  | { kind: 'part'; id: string; index: number; parts: number; chunk: string }
  | { kind: 'end'; id: string; sha256: string };

/**
 * Parse one intake text into a frame. Returns null for ordinary texts and
 * 'malformed' for a marker that does not satisfy the grammar; the parser does
 * not check per-transfer bounds beyond the id/parts/sha shapes.
 */
export function parsePatchFrame(text: string): PatchFrame | 'malformed' | null {
  if (typeof text !== 'string' || !isPatchFrameText(text)) return null;
  if (text.length > PATCH_FRAME_MAX) return 'malformed';
  if (text.startsWith(`${PATCH_FRAME_MARKERS[0]} `) || text === PATCH_FRAME_MARKERS[0]) {
    const m = BEGIN_RE.exec(text);
    if (!m) return 'malformed';
    const [, id, parts, sha256] = m;
    const count = Number(parts);
    return ID_RE.test(id) && Number.isSafeInteger(count) && count >= 1 && count <= PATCH_MAX_PARTS
      ? { kind: 'begin', id, parts: count, sha256 } : 'malformed';
  }
  if (text.startsWith(`${PATCH_FRAME_MARKERS[1]} `) || text === PATCH_FRAME_MARKERS[1]) {
    const newline = text.indexOf('\n');
    const header = newline === -1 ? text : text.slice(0, newline);
    const m = PART_RE.exec(header);
    if (!m) return 'malformed';
    const [, id, index, parts] = m;
    const i = Number(index);
    const total = Number(parts);
    return ID_RE.test(id) && Number.isSafeInteger(i) && i >= 1 && Number.isSafeInteger(total) &&
      total >= 1 && total <= PATCH_MAX_PARTS && i <= total && newline !== -1
      ? { kind: 'part', id, index: i, parts: total, chunk: text.slice(newline + 1) } : 'malformed';
  }
  if (text.startsWith(`${PATCH_FRAME_MARKERS[2]} `) || text === PATCH_FRAME_MARKERS[2]) {
    const m = END_RE.exec(text);
    if (!m) return 'malformed';
    const [, id, sha256] = m;
    return ID_RE.test(id) ? { kind: 'end', id, sha256 } : 'malformed';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

export interface PatchReceipt {
  v: 1;
  id: string;
  outcome: 'verified' | 'rejected' | 'expired';
  /** reject reason: conflict | hash-mismatch | corrupt-state | oversize | expired */
  reason?: string;
  sha256?: string;
  parts?: number;
  bytes?: number;
  rowids: number[];
  senderId: string;
  completedAt: string;
}

interface OpenTransfer {
  v: 1;
  id: string;
  parts: number;
  sha256: string;
  senderId: string;
  beganAt: string;
  rowids: number[];
  chunks: Record<string, string>;
  ended?: string;
}

interface TransferState {
  v: 1;
  /** Highest frame rowid ever examined. */
  lastRowid: number;
  /** Bounded ring of handled frame rowids (dedup by rowid). */
  handledRowids: number[];
}

export interface PatchSweepReport {
  schema: 'imessage.patch-transfer.v1';
  state: 'healthy' | 'missing' | 'busy' | 'unavailable';
  /** Open transfers examined this pass. */
  examined: number;
  /** Open transfers expired this pass. */
  expired: number;
  /** Open transfers still awaiting parts after the pass. */
  open: number;
  /** Durable watermark after this pass. */
  lastRowid: number;
}

export type PatchFrameOutcome =
  | 'consumed' | 'completed' | 'rejected' | 'duplicate' | 'refused' | 'unavailable';

const patchesDir = (runsDir?: string): string => join(imessageStateDir(runsDir), PATCHES_DIR);
const openDir = (runsDir?: string): string => join(patchesDir(runsDir), OPEN_DIR);
const statePath = (runsDir?: string): string => join(patchesDir(runsDir), STATE_FILE);
const openPath = (id: string, runsDir?: string): string => join(openDir(runsDir), `${id}.json`);
const artifactPath = (id: string, runsDir?: string): string => join(patchesDir(runsDir), `${id}.patch`);
const receiptPath = (id: string, runsDir?: string): string => join(patchesDir(runsDir), `${id}.receipt.json`);

const exists = (path: string): boolean => {
  try { lstatSync(path); return true; } catch { return false; }
};

function readState(runsDir?: string): TransferState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(runsDir), 'utf8')) as Partial<TransferState>;
    const rowids = parsed.handledRowids;
    return parsed.v === 1 && Number.isSafeInteger(parsed.lastRowid) && (parsed.lastRowid as number) >= 0 &&
      Array.isArray(rowids) && rowids.length <= PATCH_HANDLED_MAX &&
      rowids.every((r) => Number.isSafeInteger(r) && (r as number) > 0)
      ? { v: 1, lastRowid: parsed.lastRowid as number, handledRowids: rowids as number[] } : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { v: 1, lastRowid: 0, handledRowids: [] } : null;
  }
}

function writeState(state: TransferState, runsDir: string | undefined, dir: string, at: Date): void {
  writePrivateFileAtomically(join(dir, `.${randomUUID()}.tmp`), statePath(runsDir),
    JSON.stringify({ ...state, updatedAt: at.toISOString() }), { anchorPath: dir, label: 'Patch transfer state' });
}

function readOpen(id: string, runsDir?: string): OpenTransfer | null | 'corrupt' {
  let raw: string;
  try { raw = readFileSync(openPath(id, runsDir), 'utf8'); }
  catch { return null; }
  try {
    const parsed = JSON.parse(raw) as Partial<OpenTransfer>;
    const chunks = parsed.chunks;
    if (parsed.v !== 1 || !ID_RE.test(String(parsed.id)) || parsed.id !== id ||
      !Number.isSafeInteger(parsed.parts) || (parsed.parts as number) < 1 || (parsed.parts as number) > PATCH_MAX_PARTS ||
      !SHA_RE.test(String(parsed.sha256)) || !/^imessage:[a-f0-9]{16}$/.test(String(parsed.senderId)) ||
      typeof parsed.beganAt !== 'string' || !Number.isFinite(Date.parse(parsed.beganAt)) ||
      !Array.isArray(parsed.rowids) || (parsed.rowids as unknown[]).some((r) => !Number.isSafeInteger(r) || (r as number) <= 0) ||
      (parsed.rowids as number[]).length > PATCH_MAX_PARTS + 2 ||
      parsed.ended !== undefined && !SHA_RE.test(String(parsed.ended)) ||
      chunks === null || typeof chunks !== 'object' || Array.isArray(chunks)) return 'corrupt';
    for (const [index, chunk] of Object.entries(chunks as Record<string, unknown>)) {
      if (!/^[1-9][0-9]*$/.test(index) || Number(index) > (parsed.parts as number) ||
        typeof chunk !== 'string' || chunk.length > PATCH_FRAME_MAX) return 'corrupt';
    }
    return parsed as OpenTransfer;
  } catch {
    return 'corrupt';
  }
}

function writeOpen(open: OpenTransfer, runsDir: string | undefined, dir: string): void {
  writePrivateFileAtomically(join(dir, `.${randomUUID()}.tmp`), openPath(open.id, runsDir),
    JSON.stringify(open), { anchorPath: dir, label: 'Patch transfer' });
}

function writeReceipt(receipt: PatchReceipt, runsDir: string | undefined, dir: string): void {
  writePrivateFileAtomically(join(dir, `.${randomUUID()}.tmp`), receiptPath(receipt.id, runsDir),
    JSON.stringify(receipt), { anchorPath: dir, label: 'Patch receipt' });
}

function writeArtifact(id: string, payload: string, runsDir: string | undefined, dir: string): void {
  writePrivateFileAtomically(join(dir, `.${randomUUID()}.tmp`), artifactPath(id, runsDir),
    payload, { anchorPath: dir, label: 'Patch artifact' });
}

const spent = (id: string, runsDir?: string): boolean =>
  exists(receiptPath(id, runsDir)) || exists(artifactPath(id, runsDir));

const removeOpen = (id: string, runsDir?: string): void => {
  try { unlinkSync(openPath(id, runsDir)); } catch { /* already gone */ }
};

const listOpenIds = (runsDir?: string): string[] => {
  try {
    return readdirSync(openDir(runsDir))
      .map((name) => /^(.*)\.json$/.exec(name)?.[1])
      .filter((id): id is string => typeof id === 'string' && ID_RE.test(id))
      .sort();
  } catch { return []; }
};

/**
 * A transfer id is spent once a receipt exists for it: rejected, expired or
 * verified alike — the sender must pick a fresh id to retry. `spent` marks
 * that in-place; the row is handled either way.
 */
function finish(
  open: OpenTransfer, outcome: PatchReceipt['outcome'], reason: string | undefined,
  runsDir: string | undefined, dir: string, at: Date, payload?: string,
): 'completed' | 'rejected' {
  const declared = SHA_RE.test(open.sha256) && open.parts >= 1
    ? { sha256: open.sha256, parts: open.parts } : {};
  const receipt: PatchReceipt = {
    v: 1, id: open.id, outcome,
    ...(reason ? { reason } : {}),
    ...declared,
    ...(outcome === 'verified' ? { bytes: Buffer.byteLength(payload ?? '', 'utf8') } : {}),
    rowids: open.rowids.slice(0, PATCH_MAX_PARTS + 2),
    senderId: open.senderId, completedAt: at.toISOString(),
  };
  if (outcome === 'verified') writeArtifact(open.id, payload ?? '', runsDir, dir);
  writeReceipt(receipt, runsDir, dir);
  removeOpen(open.id, runsDir);
  return outcome === 'verified' ? 'completed' : 'rejected';
}

/**
 * Consume one allowlisted non-Mason intake row if it is a PATCH frame.
 * `{handled:false}` means the text was ordinary conversation; otherwise the
 * outcome is terminal for that rowid (recorded in the dedup ring and the
 * watermark) and a retry is a `duplicate`. 'unavailable' means the private
 * ledger itself failed — the caller defers the batch so the frame is retried.
 * Never throws.
 */
export function recordPatchFrame(
  msg: { rowid: number; handle: string; text: string },
  opts: { runsDir?: string; now?: () => Date } = {},
): { handled: boolean; outcome: PatchFrameOutcome; id?: string } {
  const parsed = parsePatchFrame(msg?.text ?? '');
  if (parsed === null) return { handled: false, outcome: 'consumed' };
  const id = parsed === 'malformed' ? undefined : parsed.id;
  const dir = patchesDir(opts.runsDir);
  const at = (opts.now ?? (() => new Date()))();
  let held: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    if (!Number.isSafeInteger(msg.rowid) || msg.rowid <= 0 || typeof msg.handle !== 'string' || !msg.handle.trim()) {
      return { handled: true, outcome: 'refused', id };
    }
    ensurePrivateDirectory(dir);
    ensurePrivateDirectory(openDir(opts.runsDir));
    held = acquireLocalStoreLockWithOutcome(join(dir, LOCK_FILE), 0, { anchorPath: dir });
    if (held.state !== 'acquired') return { handled: true, outcome: 'unavailable', id };
    const state = readState(opts.runsDir);
    if (state === null) return { handled: true, outcome: 'unavailable', id };
    const mark = (): void => {
      if (!state.handledRowids.includes(msg.rowid)) state.handledRowids.push(msg.rowid);
      if (state.handledRowids.length > PATCH_HANDLED_MAX) state.handledRowids.splice(0, state.handledRowids.length - PATCH_HANDLED_MAX);
      state.lastRowid = Math.max(state.lastRowid, msg.rowid);
    };
    if (state.handledRowids.includes(msg.rowid)) {
      mark();
      writeState(state, opts.runsDir, dir, at);
      return { handled: true, outcome: 'duplicate', id };
    }
    const done = (outcome: PatchFrameOutcome, transfer?: string): { handled: boolean; outcome: PatchFrameOutcome; id?: string } => {
      mark();
      writeState(state, opts.runsDir, dir, at);
      return { handled: true, outcome, id: transfer ?? id };
    };
    if (parsed === 'malformed') return done('refused');
    const frame = parsed;
    // BEGIN/END are pure protocol tokens (id, counts, a public digest). Only a
    // PART chunk is free text, and it must survive the secret scrub verbatim:
    // a chunk that cannot be stored raw is refused, never partially recorded.
    if (frame.kind === 'part' && scrubSecrets(frame.chunk) !== frame.chunk) return done('refused');
    if (spent(frame.id, opts.runsDir)) return done('refused', frame.id);
    const sender = senderIdFor(msg.handle);
    const open = readOpen(frame.id, opts.runsDir);
    if (open === 'corrupt') {
      // Our own state file failed validation; spend the id so it cannot wedge the lane.
      const ghost: OpenTransfer = { v: 1, id: frame.id, parts: 1, sha256: '0'.repeat(64), senderId: sender, beganAt: at.toISOString(), rowids: [], chunks: {} };
      return done(finish(ghost, 'rejected', 'corrupt-state', opts.runsDir, dir, at), frame.id);
    }
    if (frame.kind === 'begin') {
      if (open) {
        if (open.parts === frame.parts && open.sha256 === frame.sha256 && open.senderId === sender) return done('consumed', frame.id);
        return done(finish(open, 'rejected', 'conflict', opts.runsDir, dir, at), frame.id);
      }
      if (listOpenIds(opts.runsDir).length >= PATCH_MAX_OPEN) return done('refused', frame.id);
      writeOpen({ v: 1, id: frame.id, parts: frame.parts, sha256: frame.sha256, senderId: sender, beganAt: at.toISOString(), rowids: [msg.rowid], chunks: {} }, opts.runsDir, dir);
      return done('consumed', frame.id);
    }
    if (!open) return done('refused', frame.id);
    if (open.senderId !== sender) return done(finish(open, 'rejected', 'conflict', opts.runsDir, dir, at), frame.id);
    if (frame.kind === 'part') {
      if (frame.parts !== open.parts) return done(finish(open, 'rejected', 'conflict', opts.runsDir, dir, at), frame.id);
      const prior = open.chunks[String(frame.index)];
      if (prior !== undefined && prior !== frame.chunk) return done(finish(open, 'rejected', 'conflict', opts.runsDir, dir, at), frame.id);
      if (prior === undefined) {
        open.chunks[String(frame.index)] = frame.chunk;
        open.rowids.push(msg.rowid);
      }
      // Payload is bounded before any join: each stored chunk is already capped.
      if (Buffer.byteLength(Object.values(open.chunks).join(''), 'utf8') > PATCH_PAYLOAD_MAX_BYTES) {
        return done(finish(open, 'rejected', 'oversize', opts.runsDir, dir, at), frame.id);
      }
      if (open.ended !== undefined && Object.keys(open.chunks).length === open.parts) {
        return done(verify(open, opts.runsDir, dir, at), frame.id);
      }
      writeOpen(open, opts.runsDir, dir);
      return done('consumed', frame.id);
    }
    // frame.kind === 'end'
    if (frame.sha256 !== open.sha256) return done(finish(open, 'rejected', 'hash-mismatch', opts.runsDir, dir, at), frame.id);
    open.ended = frame.sha256;
    open.rowids.push(msg.rowid);
    if (Object.keys(open.chunks).length === open.parts) return done(verify(open, opts.runsDir, dir, at), frame.id);
    writeOpen(open, opts.runsDir, dir);
    return done('consumed', frame.id);
  } catch {
    return { handled: true, outcome: 'unavailable', id };
  } finally {
    if (held?.state === 'acquired') releaseLocalStoreLock(held.lock);
  }
}

/** Assemble and verify; only an exact sha256 match writes the artifact. */
function verify(open: OpenTransfer, runsDir: string | undefined, dir: string, at: Date): 'completed' | 'rejected' {
  const payload = Array.from({ length: open.parts }, (_, i) => open.chunks[String(i + 1)] ?? '').join('');
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return digest === open.sha256
    ? finish(open, 'verified', undefined, runsDir, dir, at, payload)
    : finish(open, 'rejected', 'hash-mismatch', runsDir, dir, at);
}

/**
 * One bounded pass over open transfers: any transfer begun before
 * `now - PATCH_TRANSFER_TTL_MS` is written as an expired receipt and removed,
 * so its rowids and id are spent forever. The state watermark is advanced past
 * every handled rowid (it only ever moves forward). Never throws.
 */
export function sweepPatchTransfers(opts: {
  runsDir?: string;
  now?: () => Date;
  ttlMs?: number;
} = {}): PatchSweepReport {
  const report: PatchSweepReport = { schema: 'imessage.patch-transfer.v1', state: 'unavailable', examined: 0, expired: 0, open: 0, lastRowid: 0 };
  const dir = patchesDir(opts.runsDir);
  const at = (opts.now ?? (() => new Date()))();
  const ttl = opts.ttlMs ?? PATCH_TRANSFER_TTL_MS;
  let held: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    if (!exists(dir)) return { ...report, state: 'missing' };
    held = acquireLocalStoreLockWithOutcome(join(dir, LOCK_FILE), 0, { anchorPath: dir });
    if (held.state !== 'acquired') return { ...report, state: held.state === 'contended' ? 'busy' : 'unavailable' };
    const state = readState(opts.runsDir);
    if (state === null) return { ...report, state: 'unavailable' };
    report.lastRowid = state.lastRowid;
    const ids = listOpenIds(opts.runsDir).slice(0, PATCH_MAX_OPEN * 4);
    report.examined = ids.length;
    for (const id of ids) {
      const open = readOpen(id, opts.runsDir);
      if (open === null) continue;
      const corrupt = open === 'corrupt';
      const stale = !corrupt && at.getTime() - Date.parse(open.beganAt) > ttl;
      if (!corrupt && !stale) { report.open++; continue; }
      const shell: OpenTransfer = corrupt
        ? { v: 1, id, parts: 1, sha256: '0'.repeat(64), senderId: 'imessage:0000000000000000', beganAt: at.toISOString(), rowids: [], chunks: {} }
        : open;
      finish(shell, corrupt ? 'rejected' : 'expired', corrupt ? 'corrupt-state' : 'expired', opts.runsDir, dir, at);
      for (const rowid of shell.rowids) {
        if (!state.handledRowids.includes(rowid)) state.handledRowids.push(rowid);
      }
      if (state.handledRowids.length > PATCH_HANDLED_MAX) state.handledRowids.splice(0, state.handledRowids.length - PATCH_HANDLED_MAX);
      report.expired++;
    }
    state.lastRowid = Math.max(state.lastRowid, ...state.handledRowids, 0);
    writeState(state, opts.runsDir, dir, at);
    report.lastRowid = state.lastRowid;
    return { ...report, state: 'healthy' };
  } catch {
    return report;
  } finally {
    if (held?.state === 'acquired') releaseLocalStoreLock(held.lock);
  }
}

/**
 * Bounded receipt listing for the findings bridge's artifact announcements.
 * Receipts are evidence files; a corrupt one is skipped, never fatal. The
 * newest PATCH_RECEIPT_SCAN_MAX by file mtime are returned, oldest first.
 */
export function readPatchReceipts(opts: { runsDir?: string } = {}): { state: 'healthy' | 'missing' | 'degraded'; receipts: PatchReceipt[] } {
  try {
    const dir = patchesDir(opts.runsDir);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.receipt.json'));
    } catch { return { state: 'missing', receipts: [] }; }
    // Receipts accumulate for the life of the install; only the newest
    // PATCH_RECEIPT_SCAN_MAX by mtime are parsed each pass.
    const newest = names.map((name) => {
      try { return { name, mtime: lstatSync(join(dir, name)).mtimeMs }; }
      catch { return { name, mtime: 0 }; }
    }).sort((a, b) => b.mtime - a.mtime).slice(0, PATCH_RECEIPT_SCAN_MAX);
    const receipts: PatchReceipt[] = [];
    let degraded = false;
    for (const { name } of newest) {
      let parsed: Partial<PatchReceipt>;
      try { parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<PatchReceipt>; }
      catch { degraded = true; continue; }
      if (parsed.v !== 1 || !ID_RE.test(String(parsed.id)) ||
        !['verified', 'rejected', 'expired'].includes(String(parsed.outcome)) ||
        typeof parsed.completedAt !== 'string' || !Number.isFinite(Date.parse(parsed.completedAt)) ||
        !/^imessage:[a-f0-9]{16}$/.test(String(parsed.senderId)) ||
        !Array.isArray(parsed.rowids) || (parsed.rowids as unknown[]).some((r) => !Number.isSafeInteger(r) || (r as number) <= 0) ||
        parsed.sha256 !== undefined && !SHA_RE.test(String(parsed.sha256)) ||
        parsed.parts !== undefined && (!Number.isSafeInteger(parsed.parts) || (parsed.parts as number) < 1) ||
        parsed.bytes !== undefined && (!Number.isSafeInteger(parsed.bytes) || (parsed.bytes as number) < 0)) {
        degraded = true;
        continue;
      }
      receipts.push(parsed as PatchReceipt);
    }
    receipts.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || a.id.localeCompare(b.id));
    return { state: degraded ? 'degraded' : 'healthy', receipts: receipts.slice(-PATCH_RECEIPT_SCAN_MAX) };
  } catch {
    return { state: 'degraded', receipts: [] };
  }
}
