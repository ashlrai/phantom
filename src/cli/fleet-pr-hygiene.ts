/**
 * `ashlr fleet pr-hygiene` — read-only audit of open PRs into a
 * fleet.pr-hygiene.v1 triage report for the merge cockpit.
 *
 * One `gh pr list` page of open PRs plus a merged-PR page and the local job
 * prompts (the same superseded evidence `ashlr fleet superseded` uses) feed
 * auditPrHygiene: every PR is flagged stale (idle ≥ --stale-days),
 * conflicted (GitHub reports a merge conflict), overlapping (shares files
 * with other open PRs), superseded (a merged fleet job's prompt named it),
 * behind or draft, then triaged close-candidate / refix / review / ok.
 *
 * READ-ONLY: the only gh calls are `pr list`. This command never closes,
 * updates or merges a pull request and never reads a PR body. A failed open
 * read still emits the versioned shape with `reads.open: 'failed'` (exit 1)
 * so the cockpit sees unavailability instead of a fake-clean backlog; failed
 * merged or prompt reads degrade only the superseded leg (`reads` says so).
 *
 * Exit codes: 0 audit produced (findings are data, not a verdict),
 * 1 open-PR list unreadable, 2 bad usage.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import {
  auditPrHygiene,
  failedPrHygieneReport,
  parsePrHygieneOpenPr,
  type PrHygieneItem,
} from '../core/fleet/pr-hygiene.js';
import type { MergedFleetPr } from '../core/fleet/superseded-prs.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const USAGE = `Usage: ashlr fleet pr-hygiene [--repo <owner/name>] [--stale-days <n>] [--limit <n>] [--json]
Audit open PRs for stale, conflicting, file-overlapping and superseded candidates.
Emits a fleet.pr-hygiene.v1 report; text mode lists flagged PRs. Read-only: gh pr list reads only.
Defaults: --repo ashlrai/phantom --stale-days 7 --limit 500. Exit 1 when the open list cannot be read.`;

/** The fleet workbench's own backlog when --repo is not given. */
const DEFAULT_REPO = 'ashlrai/phantom';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const MERGED_LIMIT = 1000;
const DEFAULT_STALE_DAYS = 7;
const MAX_STALE_DAYS = 365;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const OPEN_FIELDS =
  'number,title,url,headRefName,isDraft,mergeable,mergeStateStatus,createdAt,updatedAt,files';
const MERGED_FIELDS = 'number,title';

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

/** Job prompts under the runs dir; ASHLR_RUNS_DIR overrides like the other fleet readers. */
async function readPrompts(): Promise<ReadonlyMap<string, string>> {
  const directory = join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'queue', 'prompts');
  const entries = await readdir(directory, { withFileTypes: true });
  const prompts = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(RQ-[A-Za-z0-9_-]+)\.md$/.exec(entry.name);
    if (match && entry.isFile()) prompts.set(match[1]!, await readFile(join(directory, entry.name), 'utf8'));
  }
  return prompts;
}

export interface FleetPrHygieneDeps {
  gh?: CloudGh;
  prompts?: () => Promise<ReadonlyMap<string, string>>;
  now?: () => Date;
}

type GhRead = { ok: true; rows: unknown[] } | { ok: false; reason: string };

async function listPrs(gh: CloudGh, repo: string, state: 'open' | 'merged', limit: number, fields: string): Promise<GhRead> {
  const result = await gh(['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', fields]);
  if (!result.ok) return { ok: false, reason: 'gh-pr-list-failed' };
  try {
    const rows: unknown = JSON.parse(result.stdout);
    return Array.isArray(rows) ? { ok: true, rows } : { ok: false, reason: 'gh-pr-list-not-an-array' };
  } catch {
    return { ok: false, reason: 'gh-pr-list-not-json' };
  }
}

const positiveInt = (raw: string | undefined, max: number): number | null => {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
};

function detailLine(item: PrHygieneItem): string {
  const parts: string[] = [];
  if (item.supersededBy) parts.push(`superseded by merged #${item.supersededBy.number} (${item.supersededBy.jobId})`);
  if (item.flags.includes('conflicted')) parts.push('merge conflict');
  if (item.flags.includes('stale')) parts.push(`idle ${item.idleDays}d`);
  if (item.overlap) parts.push(`shares files with ${item.overlap.prs.map(n => `#${n}`).join(', ')}${item.overlap.count > item.overlap.prs.length ? ` (+${item.overlap.count - item.overlap.prs.length})` : ''}`);
  const secondary = item.flags.filter(f => !['superseded', 'conflicted', 'stale', 'overlap'].includes(f));
  if (secondary.length) parts.push(`also: ${secondary.join(', ')}`);
  return parts.join('; ');
}

export async function cmdFleetPrHygiene(args: string[], deps: FleetPrHygieneDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  const seen = new Set<string>();
  let repo = DEFAULT_REPO;
  let limit = DEFAULT_LIMIT;
  let staleDays = DEFAULT_STALE_DAYS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seen.has(arg)) {
      seen.add(arg);
    } else if (arg === '--repo' && !seen.has(arg)) {
      const value = args[++i];
      if (!REPO_RE.test(value ?? '')) {
        process.stderr.write(`error: --repo requires <owner/name>, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      repo = value!;
      seen.add(arg);
    } else if ((arg === '--stale-days' || arg === '--limit') && !seen.has(arg)) {
      const max = arg === '--limit' ? MAX_LIMIT : MAX_STALE_DAYS;
      const n = positiveInt(args[i + 1], max);
      if (n === null) {
        process.stderr.write(`error: ${arg} requires an integer 1..${max}, got: ${args[i + 1] ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      if (arg === '--limit') limit = n; else staleDays = n;
      i++;
      seen.add(arg);
    } else {
      process.stderr.write(`error: invalid fleet pr-hygiene argument: ${arg}\n${USAGE}\n`);
      return 2;
    }
  }

  const now = deps.now ?? (() => new Date());
  const gh = deps.gh ?? defaultGh;
  const pageRead = await listPrs(gh, repo, 'open', limit, OPEN_FIELDS);
  if (!pageRead.ok) {
    if (seen.has('--json')) {
      console.log(JSON.stringify(failedPrHygieneReport({ repo, staleDays, limit, reason: pageRead.reason, now: now() })));
    } else {
      process.stderr.write(`fleet pr-hygiene: could not read open PRs for ${repo} — ${pageRead.reason}\n`);
    }
    return 1;
  }

  const pageRows = pageRead.rows.slice(0, limit);
  const prs = pageRows.flatMap(row => {
    const pr = parsePrHygieneOpenPr(row);
    return pr === null ? [] : [pr];
  });

  // The superseded leg degrades alone: a failed merged read or a missing
  // prompts directory skips supersession evidence, never the whole audit.
  const [mergedRead, prompts] = await Promise.all([
    listPrs(gh, repo, 'merged', MERGED_LIMIT, MERGED_FIELDS),
    (deps.prompts ?? readPrompts)().then(map => map as ReadonlyMap<string, string> | 'unavailable').catch(() => 'unavailable' as const),
  ]);
  const merged: MergedFleetPr[] | 'failed' = mergedRead.ok
    ? mergedRead.rows.flatMap(row => {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) return [];
        const raw = row as Record<string, unknown>;
        return Number.isSafeInteger(raw['number']) && (raw['number'] as number) > 0 && typeof raw['title'] === 'string'
          ? [{ number: raw['number'] as number, title: raw['title'] as string }]
          : [];
      })
    : 'failed';

  const report = auditPrHygiene({ repo, open: prs, merged, prompts, staleDays, limit, observedOpen: pageRows.length, now: now() });
  if (seen.has('--json')) {
    console.log(JSON.stringify(report));
    return 0;
  }

  const flagged = report.items.filter(item => item.triage !== 'ok');
  console.log(`PR hygiene ${repo}: ${report.counts.open} open, ${flagged.length} flagged (stale = idle ≥${staleDays}d)` +
    `${report.complete ? '' : ` — page limit ${limit} reached; audit incomplete`}` +
    `${report.counts.unreadable ? `, ${report.counts.unreadable} row(s) gh could not describe` : ''}`);
  for (const item of flagged) {
    const detail = detailLine(item);
    console.log(`  ${item.triage.padEnd(15)} #${item.number} ${item.title}${detail ? ` — ${detail}` : ''}`);
  }
  if (report.reads.merged !== 'ok' || report.reads.prompts !== 'ok') {
    const degraded = [
      report.reads.merged !== 'ok' ? `merged read ${report.reads.merged}` : null,
      report.reads.prompts !== 'ok' ? `prompts ${report.reads.prompts}` : null,
    ].filter(Boolean).join(', ');
    console.log(`  superseded evidence unavailable (${degraded}) — supersession not evaluated`);
  }
  console.log(`Unflagged: ${report.counts.triage.ok}`);
  return 0;
}
