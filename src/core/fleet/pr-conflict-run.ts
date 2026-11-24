/** Live GitHub adapter for the dry-run-first PR conflict resolver. */
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGitRunner } from '../verse/git-ops.js';
import { parseHoldList } from './rebase-plan.js';
import { resolvePrConflicts, type ConflictPr } from './pr-conflict-resolver.js';

export interface ConflictRunOptions {
  apply: boolean; repo: string; root?: string; outputDir?: string; allowlistFile?: string; pr?: number; limit: number;
}
const FIELDS = 'number,state,headRefName,headRefOid,headRepository,baseRefName,mergeStateStatus,mergeable';
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

interface PrEnvelope {
  number: number; state: string; headSha: string; headRef: string; headRepo: string | null; baseRef: string;
}

function parseEnvelope(value: unknown): PrEnvelope | null {
  const row = record(value), head = record(row?.['headRepository']);
  if (!row || !Number.isSafeInteger(row['number']) || (row['number'] as number) < 1
    || ['state', 'headRefOid', 'headRefName', 'baseRefName'].some(key => typeof row[key] !== 'string')) return null;
  const headRepo = typeof head?.['nameWithOwner'] === 'string' && head['nameWithOwner'].trim()
    ? head['nameWithOwner'] : null;
  return { number: row['number'] as number, state: row['state'] as string, headSha: row['headRefOid'] as string,
    headRef: row['headRefName'] as string, headRepo, baseRef: row['baseRefName'] as string };
}

function parsePr(value: unknown): ConflictPr | null {
  const envelope = parseEnvelope(value);
  if (!envelope?.headRepo) return null;
  return { number: envelope.number, state: envelope.state, headSha: envelope.headSha,
    headRef: envelope.headRef, headRepo: envelope.headRepo, baseRef: envelope.baseRef };
}

export async function runPrConflictResolution(options: ConflictRunOptions): Promise<unknown> {
  const root = options.root ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const holds = async (): Promise<Set<string>> => {
    const text = await readFile(join(root, 'queue', 'hold-list.txt'), 'utf8');
    if (text.length > 1024 * 1024) throw new Error('oversized hold list');
    return parseHoldList(text);
  };
  const gh = async (args: string[]): Promise<unknown> => {
    const result = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 8 * 1024 * 1024 });
    if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('GitHub read unavailable');
    return JSON.parse(result.stdout) as unknown;
  };
  // No partial mutation when hold evidence or the configurable allowlist cannot be read.
  const hold = await holds();
  let allowlist: string[] | undefined;
  if (options.allowlistFile) {
    const value: unknown = JSON.parse(await readFile(options.allowlistFile, 'utf8'));
    if (!Array.isArray(value) || value.length > 100 || !value.every(path => typeof path === 'string' && path.length < 240)) throw new Error('invalid allowlist');
    allowlist = value as string[];
  }
  const metadata = record(await gh(['repo', 'view', options.repo, '--json', 'defaultBranchRef']));
  const defaultBranch = record(metadata?.['defaultBranchRef'])?.['name'];
  if (typeof defaultBranch !== 'string' || !defaultBranch) throw new Error('default branch unavailable');
  const rows = options.pr
    ? [await gh(['pr', 'view', String(options.pr), '--repo', options.repo, '--json', FIELDS])]
    : await gh(['pr', 'list', '--repo', options.repo, '--state', 'open', '--limit', String(options.limit), '--json', FIELDS]);
  if (!Array.isArray(rows)) throw new Error('invalid PR snapshot');
  const snapshots = rows.map(value => {
    const row = record(value), pr = parseEnvelope(value);
    return row && pr ? { row, pr } : null;
  });
  if (snapshots.some(snapshot => !snapshot)) throw new Error('invalid PR snapshot');
  const prs = [];
  for (const snapshot of snapshots) {
    const { row, pr } = snapshot!;
    if (pr.state !== 'OPEN' || (row['mergeStateStatus'] !== 'DIRTY' && row['mergeable'] !== 'CONFLICTING')) continue;
    if (!pr.headRepo) {
      prs.push({ number: pr.number, head: pr.headSha, dryRun: !options.apply, status: 'head-unavailable',
        reason: 'The PR source repository is unavailable.', files: [], hunks: [], commands: [] });
      continue;
    }
    const conflictPr: ConflictPr = { number: pr.number, state: pr.state, headSha: pr.headSha,
      headRef: pr.headRef, headRepo: pr.headRepo, baseRef: pr.baseRef };
    prs.push(await resolvePrConflicts({ repo: options.repo, pr: conflictPr, defaultBranch,
      remote: `https://github.com/${options.repo}.git`, hold, allowlist, apply: options.apply,
      outputDir: options.outputDir ?? join(root, 'conflictres'),
      refresh: async () => {
        const currentHold = await holds();
        const repo = options.repo.toLowerCase(), short = repo.split('/')[1]!;
        if ([...currentHold].some(key => [`${repo}#${conflictPr.number}`, `${short}#${conflictPr.number}`].includes(key.toLowerCase()))) return null;
        return parsePr(await gh(['pr', 'view', String(conflictPr.number), '--repo', options.repo, '--json', FIELDS]));
      },
      // publish.sh only supports fleet job branches and reviewed integrated merges.
      // No arbitrary-existing-head adapter exists: export a complete supersede bundle.
    }));
  }
  return { schema: 'pr.resolve-conflicts.v1', repo: options.repo, dryRun: !options.apply,
    complete: Boolean(options.pr) || rows.length < options.limit, prs };
}
