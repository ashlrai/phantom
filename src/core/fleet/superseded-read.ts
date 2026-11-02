/** Read-only "superseded by" report for the Verse fleet API: the same answer
 * `ashlr fleet superseded` prints on a terminal, served so the Merges pane and
 * the phone can ask for it. An uncached call is two `gh pr list` reads plus a
 * prompts-dir scan; nothing here mutates git, GitHub or disk. */
import { readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../cloud/pr-actions.js';
import { findSupersededPrs, type MergedFleetPr, type OpenFleetPr } from './superseded-prs.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';

/** GET path on the Verse fleet API; the wire shape below is pinned with the Merges pane job. */
export const VERSE_FLEET_SUPERSEDED_PATH = '/api/verse/fleet/runs/superseded';

export interface SupersededPairV1 {
  open: number;
  openTitle: string;
  openState: string;
  mergedBy: number;
  mergedTitle: string;
  jobId: string;
}

export interface SupersededReadV1 {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'unavailable';
  pairs: SupersededPairV1[];
  openDirty: number;
}

// The gh listing below duplicates src/cli/fleet-superseded.ts — same repo,
// --json fields, limit, transport and row validation — because that file
// belongs to another job and this read needs the identical backlog query.
const REPO = 'ashlrai/phantom';
const LIMIT = 1000;

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
// End of the duplicated gh listing.

/** The pane polls: the last good read is served for a minute before gh runs again. */
const CACHE_MS = 60_000;
let cached: { at: number; value: SupersededReadV1 } | undefined;

export async function readSuperseded(deps: {
  gh?: CloudGh;
  prompts?: () => Promise<ReadonlyMap<string, string>>;
  now?: () => Date;
} = {}): Promise<SupersededReadV1> {
  const now = deps.now ?? (() => new Date());
  if (cached && now().getTime() - cached.at < CACHE_MS) return cached.value;
  const unavailable = (): SupersededReadV1 =>
    ({ v: 1, generatedAt: now().toISOString(), source: 'unavailable', pairs: [], openDirty: 0 });
  let open: OpenFleetPr[];
  let merged: MergedFleetPr[];
  let prompts: ReadonlyMap<string, string>;
  try {
    const gh = deps.gh ?? defaultGh;
    [open, merged] = await Promise.all([listPrs(gh, 'open'), listPrs(gh, 'merged')]);
    prompts = await (deps.prompts ?? readPrompts)();
  } catch {
    return unavailable();
  }
  const pairs: SupersededPairV1[] = findSupersededPrs(open, merged, prompts).map(row => ({
    open: row.pr.number,
    openTitle: scrubSecrets(row.pr.title),
    openState: row.pr.mergeStateStatus,
    mergedBy: row.supersededBy.number,
    mergedTitle: scrubSecrets(row.supersededBy.title),
    jobId: row.evidence.jobId,
  }));
  const value: SupersededReadV1 = {
    v: 1,
    generatedAt: now().toISOString(),
    source: 'ok',
    pairs,
    openDirty: open.filter(pr => pr.mergeStateStatus === 'DIRTY').length,
  };
  cached = { at: now().getTime(), value };
  return value;
}
