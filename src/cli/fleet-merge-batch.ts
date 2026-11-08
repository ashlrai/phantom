/**
 * `phm fleet merge-batch` — READ-ONLY merge-batch planner for the merge
 * treadmill (RQ-SWE3-MERGEBATCH-1).
 *
 * Groups an open-PR snapshot into merge batches by file overlap — PRs touching
 * disjoint file sets land in any order (or concurrently); overlapping ones
 * serialize — estimates a conflict risk per batch, and proposes the serial
 * order that minimizes rebase churn: an independent clean wave merges without
 * rebasing, then each remaining PR rebases once onto the accumulated main.
 *
 * INPUT, never gh: the snapshot comes from `--input <file>` (`-` or a piped
 * stdin for a pipe), a non-TTY standard input, or the state file
 * `<runsDir>/fleet/open-prs.json` (`--root` / ASHLR_RUNS_DIR, default
 * ~/.ashlr-runs) — three accepted wire shapes: a raw `gh pr list --json
 * number,title,headRefName,isDraft,mergeable,mergeStateStatus,createdAt,
 * updatedAt,files` array, a merge-backlog read ({v:1, items}), or a
 * fleet.pr-hygiene.v1 report ({schema, items}). A scheduler snapshots
 * whichever read it already runs; this command never contacts GitHub.
 *
 * Emits a fleet.merge-batch.v1 plan. Read-only: writes nothing, grants no
 * merge, rebase or close authority. Exit 0 plan produced (findings are data),
 * 1 no usable snapshot (missing, unreadable or malformed — the JSON report
 * still says so under `input.state` — or the envelope's own upstream read
 * failed, `input.upstream`), 2 bad usage.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { looksLikeOption } from './args.js';
import {
  MERGE_BATCH_SCHEMA,
  parseMergeBatchPrs,
  planMergeBatches,
  type MergeBatchPlan,
  type MergeBatchRisk,
} from '../core/fleet/merge-batch.js';

const USAGE = `Usage: phm fleet merge-batch [--input <file>|-] [--repo <owner/name>] [--root <abs>] [--json]
Group open PRs into merge batches by file overlap and propose the order that
minimizes rebase churn. Input: a gh pr list JSON array, a merge-backlog read,
or a fleet.pr-hygiene.v1 report — via --input, piped stdin, or the state file
<root>/fleet/open-prs.json (root: ASHLR_RUNS_DIR or ~/.ashlr-runs). Read-only:
never calls gh, never writes. Exit 1 when no usable snapshot is found.`;

/** A 500-PR page with files is ~5 MiB; 32 MiB is generous headroom. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export interface FleetMergeBatchDeps {
  /** Input source read when not a TTY; defaults to process.stdin. */
  stdin?: Readable;
  /** Overrides TTY detection on `stdin` (tests). */
  stdinIsTty?: boolean;
  /** File reader for --input and the state file; defaults to fs readFile. */
  readText?: (path: string) => Promise<string>;
  /** State-file root; defaults to ASHLR_RUNS_DIR ?? ~/.ashlr-runs. */
  root?: string;
  now?: () => Date;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

type InputRead =
  | { ok: true; text: string; source: 'input-file' | 'stdin' | 'state-file'; path: string | null }
  | { ok: false; state: 'missing' | 'unreadable' | 'too-large' | 'malformed'; detail: string };

async function readStream(stdin: Readable): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) {
        stdin.destroy();
        return { ok: false, detail: `stdin exceeds ${MAX_INPUT_BYTES} bytes` };
      }
      chunks.push(buffer);
    }
  } catch {
    stdin.destroy();
    return { ok: false, detail: 'stdin read error' };
  }
  return { ok: true, text: Buffer.concat(chunks, bytes).toString('utf8') };
}

function failedPlan(repo: string | null, now: Date, input: Record<string, unknown>, error: string): MergeBatchPlan & { input: Record<string, unknown>; error: string } {
  return {
    schema: MERGE_BATCH_SCHEMA, v: 1, repo, generatedAt: now.toISOString(),
    input, error,
    counts: { open: 0, unreadable: 0, duplicates: 0, withFileData: 0, batches: 0, independent: 0, serial: 0, overlapEdges: 0, expectedRebases: 0 },
    batches: [], order: [],
  };
}

function riskLine(risk: MergeBatchRisk): string {
  return `${risk.level} (${risk.score})${risk.reasons.length ? ` — ${risk.reasons.join(', ')}` : ''}`;
}

export async function cmdFleetMergeBatch(args: string[], deps: FleetMergeBatchDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { out(USAGE + '\n'); return 0; }

  let inputPath: string | null = null;
  let repo: string | null = null;
  let json = false;
  let root = deps.root ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--input' && inputPath === null) {
      const value = args[++i];
      if (value === undefined || (looksLikeOption(value) && value !== '-')) {
        err(`error: --input requires a file path (or - for stdin)\n${USAGE}\n`);
        return 2;
      }
      inputPath = value;
      continue;
    }
    if (arg === '--repo' && repo === null) {
      const value = args[++i];
      if (!REPO_RE.test(value ?? '')) {
        err(`error: --repo requires <owner/name>, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      repo = value!;
      continue;
    }
    if (arg === '--root') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) {
        err(`error: --root requires an absolute path, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      root = value;
      continue;
    }
    err(`error: invalid fleet merge-batch argument: ${arg}\n${USAGE}\n`);
    return 2;
  }

  const now = deps.now ?? (() => new Date());
  const readText = deps.readText ?? (async (path: string) => readFile(path, 'utf8'));
  const stdin = deps.stdin ?? process.stdin;
  const tty = deps.stdinIsTty ?? Boolean((stdin as { isTTY?: boolean }).isTTY);

  // Input precedence: --input, then a piped stdin, then the state file.
  let read: InputRead;
  if (inputPath !== null && inputPath !== '-') {
    try {
      const text = await readText(inputPath);
      read = text.length > MAX_INPUT_BYTES
        ? { ok: false, state: 'too-large', detail: `${inputPath} exceeds ${MAX_INPUT_BYTES} bytes` }
        : { ok: true, text, source: 'input-file', path: inputPath };
    } catch {
      read = { ok: false, state: 'unreadable', detail: `cannot read ${inputPath}` };
    }
  } else if (inputPath === '-' || !tty) {
    const piped = await readStream(stdin);
    read = piped.ok
      ? { ok: true, text: piped.text, source: inputPath === '-' ? 'input-file' : 'stdin', path: null }
      : { ok: false, state: 'unreadable', detail: piped.detail };
  } else {
    const statePath = join(root, 'fleet', 'open-prs.json');
    try {
      const text = await readText(statePath);
      read = text.length > MAX_INPUT_BYTES
        ? { ok: false, state: 'too-large', detail: `${statePath} exceeds ${MAX_INPUT_BYTES} bytes` }
        : { ok: true, text, source: 'state-file', path: statePath };
    } catch {
      read = { ok: false, state: 'missing', detail: `no snapshot at ${statePath} — pass --input <file> or pipe a gh pr list page on stdin` };
    }
  }

  if (!read.ok) {
    const report = failedPlan(repo, now(), { source: null, path: null, state: read.state }, read.detail);
    if (json) out(JSON.stringify(report) + '\n');
    else err(`fleet merge-batch: ${read.detail}\n`);
    return 1;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(read.text);
  } catch {
    const report = failedPlan(repo, now(), { source: read.source, path: read.path, state: 'malformed' }, 'input is not JSON');
    if (json) out(JSON.stringify(report) + '\n');
    else err(`fleet merge-batch: input is not JSON (${read.path ?? 'stdin'})\n`);
    return 1;
  }

  const parsed = parseMergeBatchPrs(parsedJson);
  if (!parsed.ok) {
    const report = failedPlan(repo, now(), { source: read.source, path: read.path, state: 'malformed' }, parsed.reason);
    if (json) out(JSON.stringify(report) + '\n');
    else err(`fleet merge-batch: ${parsed.reason}\n`);
    return 1;
  }

  const plan = planMergeBatches({
    prs: parsed.prs,
    repo: parsed.repo ?? repo,
    unreadable: parsed.unreadable,
    duplicates: parsed.duplicates,
    now: now(),
  });
  const report = { ...plan, input: { kind: parsed.kind, source: read.source, path: read.path, state: 'ok', upstream: parsed.upstream } };
  if (json) {
    out(JSON.stringify(report) + '\n');
    return parsed.upstream === 'ok' || parsed.upstream === 'healthy' ? 0 : 1;
  }

  const { counts } = report;
  out(`merge-batch${report.repo ? ` ${report.repo}` : ''}: ${counts.open} open PRs → ${counts.batches} batch(es) `
    + `(${counts.serial} serial, ${counts.independent} independent); ${counts.overlapEdges} overlap edge(s), `
    + `${counts.expectedRebases} rebase(s) expected\n`);
  if (parsed.upstream !== 'ok' && parsed.upstream !== 'healthy') {
    out(`  snapshot upstream read is '${parsed.upstream}' — items may be incomplete\n`);
  }
  if (counts.unreadable || counts.duplicates) {
    out(`  ${counts.unreadable} unreadable row(s), ${counts.duplicates} duplicate PR row(s) skipped\n`);
  }
  if (counts.withFileData < counts.open) {
    out(`  ${counts.open - counts.withFileData} PR(s) carry no file data — batched independently, overlap unmeasured\n`);
  }
  for (const batch of report.batches) {
    const label = batch.kind === 'serial'
      ? `serial ×${batch.prs.length}, risk ${riskLine(batch.conflictRisk)}`
      : `independent${batch.evidence === 'no-file-data' ? ' (no file data)' : ''}`;
    out(`  ${batch.id} ${label}\n`);
    out(`    order: ${batch.order.map(n => `#${n}`).join(' → ')}\n`);
    if (batch.hotFiles.length) out(`    hot files: ${batch.hotFiles.join(', ')}\n`);
  }
  return parsed.upstream === 'ok' || parsed.upstream === 'healthy' ? 0 : 1;
}
