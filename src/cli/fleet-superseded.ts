/** Read-only report of open PRs explicitly named by merged fleet jobs. */
import { readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { findSupersededPrs, type MergedFleetPr, type OpenFleetPr } from '../core/fleet/superseded-prs.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const LIMIT = 1000;
const USAGE = 'Usage: ashlr fleet superseded [--json]';

const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

async function readPrompts(): Promise<ReadonlyMap<string, string>> {
  const directory = join(homedir(), '.ashlr-runs', 'queue', 'prompts');
  const entries = await readdir(directory, { withFileTypes: true });
  const prompts = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(RQ-[A-Za-z0-9_-]+)\.md$/.exec(entry.name);
    if (match && entry.isFile()) prompts.set(match[1]!, await readFile(join(directory, entry.name), 'utf8'));
  }
  return prompts;
}

export interface FleetSupersededDeps {
  gh?: CloudGh;
  prompts?: () => Promise<ReadonlyMap<string, string>>;
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

export async function cmdFleetSuperseded(args: string[], deps: FleetSupersededDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    process.stderr.write(`${USAGE}\n`); return 2;
  }
  let open: OpenFleetPr[];
  let merged: MergedFleetPr[];
  try {
    const gh = deps.gh ?? defaultGh;
    [open, merged] = await Promise.all([listPrs(gh, 'open'), listPrs(gh, 'merged')]);
  } catch {
    process.stderr.write('fleet superseded: backlog unavailable\n'); return 1;
  }
  let prompts: ReadonlyMap<string, string>;
  try { prompts = await (deps.prompts ?? readPrompts)(); }
  catch { process.stderr.write('fleet superseded: prompts unavailable\n'); return 1; }
  const rows = findSupersededPrs(open, merged, prompts);
  const superseded = new Set(rows.map(row => row.pr.number));
  const dirtyRemaining = open.filter(pr => pr.mergeStateStatus === 'DIRTY' && !superseded.has(pr.number)).length;
  const complete = open.length < LIMIT && merged.length < LIMIT;
  if (args[0] === '--json') {
    console.log(JSON.stringify({ repo: REPO, open: open.length, merged: merged.length, complete, rows, total: rows.length, dirtyRemaining }));
  } else {
    for (const row of rows) console.log(`#${row.pr.number} ${row.pr.title} -> merged #${row.supersededBy.number} (${row.evidence.jobId}: ${row.evidence.reference})`);
    console.log(`Total superseded: ${rows.length}${complete ? '' : ' (PR list limit reached; results incomplete)'}`);
    console.log(`DIRTY PRs remaining: ${dirtyRemaining}`);
  }
  return 0;
}
