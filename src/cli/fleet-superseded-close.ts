/**
 * `ashlr fleet superseded-close` — close open fleet bridge PRs whose recut
 * already merged. Dry run by default: without --apply it prints the close
 * plan and never runs gh. With --apply it closes one PR at a time
 * (`gh pr close <N> --repo ashlrai/phantom --comment <comment>`), stops at
 * the first non-zero exit and appends every attempt to
 * <runsDir>/queue/superseded-closes.jsonl.
 *
 * NOTE (bridge): defaultGh, listPrs and readPrompts are deliberately
 * duplicated from src/cli/fleet-superseded.ts — that file is owned by another
 * job and stays untouched. Both call sites share the same bounded reader
 * (defaultGitRunner with the same limits) so the answers cannot drift.
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { closeSupersededPrs, planSupersededClose, supersededCloseLimit, type SupersededCloseResult, type SupersededCloseRunner } from '../core/fleet/superseded-close.js';
import type { MergedFleetPr, OpenFleetPr } from '../core/fleet/superseded-prs.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const LIMIT = 1000;
const USAGE = 'Usage: ashlr fleet superseded-close [--apply] [--limit N] [--json]';

const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

const defaultRunner: SupersededCloseRunner = async (file, args) => {
  const result = await defaultGitRunner(file === 'git' ? 'git' : 'gh', args, {
    cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024,
  });
  return {
    code: result.code ?? 1,
    stdout: result.stdout,
    stderr: result.stderr || (result.missing ? 'gh binary not found' : result.timedOut ? 'gh timed out' : ''),
  };
};

const defaultRunsDir = (): string => join(homedir(), '.ashlr-runs');

async function readPrompts(): Promise<ReadonlyMap<string, string>> {
  const directory = join(defaultRunsDir(), 'queue', 'prompts');
  const entries = await readdir(directory, { withFileTypes: true });
  const prompts = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(RQ-[A-Za-z0-9_-]+)\.md$/.exec(entry.name);
    if (match && entry.isFile()) prompts.set(match[1]!, await readFile(join(directory, entry.name), 'utf8'));
  }
  return prompts;
}

export interface FleetSupersededCloseDeps {
  gh?: CloudGh;
  prompts?: () => Promise<ReadonlyMap<string, string>>;
  runner?: SupersededCloseRunner;
  runsDir?: string;
  now?: () => number;
}

function isPr(value: unknown): value is MergedFleetPr {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.number) && (row.number as number) > 0 && typeof row.title === 'string';
}

async function listPrs(gh: CloudGh, state: 'open'): Promise<OpenFleetPr[]>;
async function listPrs(gh: CloudGh, state: 'merged'): Promise<MergedFleetPr[]>;
async function listPrs(gh: CloudGh, state: 'open' | 'merged'): Promise<MergedFleetPr[]> {
  const fields = state === 'open' ? 'number,title,mergeStateStatus' : 'number,title';
  const result = await gh(['pr', 'list', '--repo', REPO, '--state', state, '--limit', String(LIMIT), '--json', fields]);
  if (!result.ok) throw new Error('gh unavailable');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || !rows.every(row => isPr(row) &&
    (state !== 'open' || typeof (row as OpenFleetPr).mergeStateStatus === 'string'))) throw new Error('invalid gh output');
  return rows;
}

interface ParsedArgs { apply: boolean; json: boolean; limit?: number }

function parseArgs(args: readonly string[]): ParsedArgs | 'help' | null {
  const out: ParsedArgs = { apply: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--limit') {
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) return null;
      out.limit = Number(value);
    } else return null;
  }
  return out;
}

export async function cmdFleetSupersededClose(args: string[], deps: FleetSupersededCloseDeps = {}): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === 'help') { console.log(USAGE); return 0; }
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`); return 2;
  }
  let open: OpenFleetPr[];
  let merged: MergedFleetPr[];
  try {
    const gh = deps.gh ?? defaultGh;
    [open, merged] = await Promise.all([listPrs(gh, 'open'), listPrs(gh, 'merged')]);
  } catch {
    process.stderr.write('fleet superseded-close: backlog unavailable\n'); return 1;
  }
  let prompts: ReadonlyMap<string, string>;
  try { prompts = await (deps.prompts ?? readPrompts)(); }
  catch { process.stderr.write('fleet superseded-close: prompts unavailable\n'); return 1; }
  const rows = planSupersededClose(open, merged, prompts);
  let result: SupersededCloseResult;
  try {
    result = await closeSupersededPrs(rows, {
      apply: parsed.apply,
      limit: parsed.limit,
      runner: deps.runner ?? defaultRunner,
      runsDir: deps.runsDir ?? defaultRunsDir(),
      now: deps.now,
    });
  } catch {
    process.stderr.write('fleet superseded-close: close failed\n'); return 1;
  }
  const limit = supersededCloseLimit(parsed.limit);
  if (parsed.json) {
    console.log(JSON.stringify({
      repo: REPO, apply: parsed.apply, limit,
      attempted: result.attempted, closed: result.closed, failed: result.failed,
      total: result.rows.length, rows: result.rows,
      ...(result.error === undefined ? {} : { error: result.error }),
    }));
  } else if (!parsed.apply) {
    for (const row of result.rows) console.log(`#${row.number} ${row.title} -> merged #${row.supersededBy}`);
    if (result.rows.length === 0) console.log('No superseded fleet PRs.');
    if (result.rows.length > limit) console.log(`Plan has ${result.rows.length} rows; --apply closes at most ${limit}.`);
    console.log('dry run: add --apply to close');
  } else {
    const attemptedRows = result.rows.slice(0, result.attempted);
    for (const row of attemptedRows.slice(0, result.closed)) console.log(`closed #${row.number}`);
    if (result.failed > 0) console.log(`failed #${attemptedRows.at(-1)?.number}: ${result.error ?? 'unknown error'}`);
    console.log(`closed ${result.closed}, failed ${result.failed}; ${result.rows.length - result.attempted} not attempted`);
  }
  return result.failed > 0 ? 1 : 0;
}
