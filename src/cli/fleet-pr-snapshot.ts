/**
 * cli/fleet-pr-snapshot.ts — shared open-PR snapshot reader for fleet verbs
 * that plan from a `gh pr list` page (fleet-merge-batch, fleet-rebase-plan).
 *
 * Resolves exactly one input source, in this order:
 *   1. `--input <file>` (`--input -` forces stdin)
 *   2. a non-TTY standard input (a piped snapshot)
 *   3. the state file `<root>/fleet/open-prs.json`
 *
 * Read-only: returns the raw text; the caller parses it into whichever wire
 * shape it accepts. A read failure reports a stable `state` token
 * (missing | unreadable | too-large | malformed) — the caller decides how to
 * surface it, but a missing/failed snapshot is never a silent empty input.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

/** A 500-PR page with files is ~5 MiB; 32 MiB is generous headroom. */
export const MAX_SNAPSHOT_INPUT_BYTES = 32 * 1024 * 1024;

export interface PrSnapshotDeps {
  /** Input source read when not a TTY; defaults to process.stdin. */
  stdin?: Readable;
  /** Overrides TTY detection on `stdin` (tests). */
  stdinIsTty?: boolean;
  /** File reader for --input and the state file; defaults to fs readFile. */
  readText?: (path: string) => Promise<string>;
  /** State-file root; defaults to ASHLR_RUNS_DIR ?? ~/.ashlr-runs. */
  root?: string;
}

export type PrSnapshotRead =
  | { ok: true; text: string; source: 'input-file' | 'stdin' | 'state-file'; path: string | null }
  | { ok: false; state: 'missing' | 'unreadable' | 'too-large'; detail: string };

export function defaultSnapshotRoot(root?: string): string {
  return root ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

async function readStream(stdin: Readable): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > MAX_SNAPSHOT_INPUT_BYTES) {
        stdin.destroy();
        return { ok: false, detail: `stdin exceeds ${MAX_SNAPSHOT_INPUT_BYTES} bytes` };
      }
      chunks.push(buffer);
    }
  } catch {
    stdin.destroy();
    return { ok: false, detail: 'stdin read error' };
  }
  return { ok: true, text: Buffer.concat(chunks, bytes).toString('utf8') };
}

/**
 * The shared read. `inputPath` is the parsed --input value (null when the
 * flag was absent; '-' selects stdin). Everything else is injectable.
 * (A const arrow, not `export async function` — the fleet-registry generator
 * would otherwise register this helper module as a `pr-snapshot` verb.)
 */
export const readPrSnapshot = async (inputPath: string | null, deps: PrSnapshotDeps = {}): Promise<PrSnapshotRead> => {
  const readText = deps.readText ?? (async (path: string) => readFile(path, 'utf8'));
  const stdin = deps.stdin ?? process.stdin;
  const tty = deps.stdinIsTty ?? Boolean((stdin as { isTTY?: boolean }).isTTY);
  const root = defaultSnapshotRoot(deps.root);

  if (inputPath !== null && inputPath !== '-') {
    try {
      const text = await readText(inputPath);
      return text.length > MAX_SNAPSHOT_INPUT_BYTES
        ? { ok: false, state: 'too-large', detail: `${inputPath} exceeds ${MAX_SNAPSHOT_INPUT_BYTES} bytes` }
        : { ok: true, text, source: 'input-file', path: inputPath };
    } catch {
      return { ok: false, state: 'unreadable', detail: `cannot read ${inputPath}` };
    }
  }
  if (inputPath === '-' || !tty) {
    const piped = await readStream(stdin);
    return piped.ok
      ? { ok: true, text: piped.text, source: inputPath === '-' ? 'input-file' : 'stdin', path: null }
      : { ok: false, state: 'unreadable', detail: piped.detail };
  }
  const statePath = join(root, 'fleet', 'open-prs.json');
  try {
    const text = await readText(statePath);
    return text.length > MAX_SNAPSHOT_INPUT_BYTES
      ? { ok: false, state: 'too-large', detail: `${statePath} exceeds ${MAX_SNAPSHOT_INPUT_BYTES} bytes` }
      : { ok: true, text, source: 'state-file', path: statePath };
  } catch {
    return { ok: false, state: 'missing', detail: `no snapshot at ${statePath} — pass --input <file> or pipe a gh pr list page on stdin` };
  }
};

/** JSON.parse of a resolved snapshot, reporting a stable state on failure. */
export function parseSnapshotJson(read: Extract<PrSnapshotRead, { ok: true }>):
  | { ok: true; value: unknown }
  | { ok: false; state: 'malformed'; detail: string } {
  try {
    return { ok: true, value: JSON.parse(read.text) };
  } catch {
    return { ok: false, state: 'malformed', detail: `input is not JSON (${read.path ?? 'stdin'})` };
  }
}
