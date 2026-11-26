/**
 * The shared queue/status.json read for the fleet status reports
 * (`fleet starved`, `fleet lane-share`, `fleet trim`, `fleet shed-plan` and
 * the `fleet_trim` MCP tool). The runs root resolves the way every other
 * queue/status.json reader does — `ASHLR_RUNS_DIR` when it names an absolute
 * directory, else `~/.ashlr-runs` — so a relocated or hermetic runs root
 * reaches these reports instead of being silently bypassed.
 *
 * A failed read keeps its kind instead of collapsing into one flat
 * "unreadable": a missing file means this machine runs no fleet and names
 * where the command looked, an unreadable file says the path exists but
 * cannot be read, bad JSON says the file is not JSON, and a parsed document
 * the report cannot use is reported by the caller's projector as not a valid
 * dispatchd status document. Read-only; the injected reader is the only
 * filesystem seam.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runsRoot } from '../metrics/loop-collect.js';

export type QueueStatusReader = (path: string) => Promise<string>;

/** `<runs>/queue/status.json` under the resolved runs root. */
export function queueStatusPath(runsDir: string = runsRoot()): string {
  return join(runsDir, 'queue', 'status.json');
}

export type QueueStatusRead =
  | { ok: true; path: string; value: unknown }
  | { ok: false; path: string; kind: 'missing' | 'unreadable' | 'invalid-json'; message: string };

export interface QueueStatusReadOptions {
  /** Filesystem seam; defaults to a utf8 readFile. Tests inject fixture readers. */
  read?: QueueStatusReader;
  /** Runs root override; defaults to runsRoot() at call time. */
  runsDir?: string;
  /** What to call the command in the missing-file message (e.g. 'phm fleet starved'). */
  subject?: string;
}

/**
 * The missing-file message names the looked-at path and the two ways forward,
 * the same contract `phm fleet unfed` prints: run on a node running the
 * fleet, or point ASHLR_RUNS_DIR at a runs root that has one.
 */
function missingQueueStatusMessage(path: string, subject: string): string {
  return `No dispatcher status at ${path}: this machine has no fleet publishing queue/status.json. `
    + `${subject} reads the local dispatcher's live state — run it on a node running the fleet, `
    + 'or set ASHLR_RUNS_DIR to a runs root that has one.';
}

/** queue/status.json parsed but not in the shape the report needs. */
export function queueStatusShapeMessage(path: string): string {
  return `Cannot read queue status: ${path} is not a valid dispatchd status document.`;
}

/** Read and JSON-parse queue/status.json, keeping the failure kind. */
export async function readQueueStatus(opts: QueueStatusReadOptions = {}): Promise<QueueStatusRead> {
  const path = queueStatusPath(opts.runsDir);
  const subject = opts.subject ?? 'This command';
  let text: string;
  try {
    text = await (opts.read ?? (p => readFile(p, 'utf8')))(path);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      return { ok: false, path, kind: 'missing', message: missingQueueStatusMessage(path, subject) };
    }
    return { ok: false, path, kind: 'unreadable', message: `Cannot read queue status: ${path} exists but cannot be read.` };
  }
  try {
    return { ok: true, path, value: JSON.parse(text) };
  } catch {
    return { ok: false, path, kind: 'invalid-json', message: `Cannot read queue status: ${path} is not valid JSON.` };
  }
}

export type QueueStatusProjector<T> = (value: unknown) => T | Promise<T>;
export type QueueStatusViewResult<T> = { ok: true; view: T } | { ok: false; message: string };

/**
 * Read queue/status.json and project it in one step: a read failure reports
 * its own message, and a projector throw (the report's shape validation)
 * reports the file as not a valid dispatchd status document. The projector
 * may be async so a report can join a second local read (fleet starved's
 * lanes snapshot) without leaving the failure mapping.
 */
export async function readQueueStatusView<T>(
  project: QueueStatusProjector<T>,
  opts: QueueStatusReadOptions = {},
): Promise<QueueStatusViewResult<T>> {
  const read = await readQueueStatus(opts);
  if (!read.ok) return { ok: false, message: read.message };
  try {
    return { ok: true, view: await project(read.value) };
  } catch {
    return { ok: false, message: queueStatusShapeMessage(read.path) };
  }
}
