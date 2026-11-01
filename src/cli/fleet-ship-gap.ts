/**
 * `ashlr fleet ship-gap` — read-only ship-gap report for the seven approved
 * repos (RQ-PHX-SHIPDRIFTCLI31).
 *
 * Agents could not see how far each repo's default branch has drifted past its
 * newest version tag (phantom is hundreds of commits past v3.29.15). For every
 * repo in QUEUEGEN_REPOS this prints the newest version tag, its age and the
 * commit count the default branch is ahead of it.
 *
 * READ-ONLY: the only gh calls are `gh api repos/{repo}`,
 * `gh api repos/{repo}/tags` and `gh api repos/{repo}/compare/{tag}...{branch}`
 * GETs — nothing is tagged, pushed or released. The per-repo read is injected
 * (ShipGapReader) so the report is fully unit-testable; the production reader
 * wraps the bounded git-ops runner.
 *
 * A failed read marks that repo `unknown` with null numbers — never a fake
 * zero drift — and exits nonzero. Exit codes: 0 all repos measured,
 * 1 at least one repo unread, 2 bad usage.
 */

import { tmpdir } from 'node:os';

import { defaultGitRunner } from '../core/verse/git-ops.js';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { QUEUEGEN_REPOS } from '../core/drive/queuegen.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, red, yellow } = makeColors(isTty());

export const FLEET_SHIP_GAP_USAGE = 'ashlr fleet ship-gap [--json]';

/** A successful per-repo measurement. */
export interface ShipGapTag {
  /** The repo's newest version tag, e.g. v3.29.15. */
  tag: string;
  /** ISO timestamp of the tagged commit (the compare call's base commit). */
  taggedAt: string;
  /** Commits on the default branch not reachable from the tag. */
  ahead: number;
}

export type ShipGapRead = ({ ok: true } & ShipGapTag) | { ok: false; reason: string };

/** One repo's drift read; the production implementation is ghShipGapReader. */
export type ShipGapReader = (repo: string) => Promise<ShipGapRead>;

export interface FleetShipGapDeps {
  /** Injected per-repo reader; defaults to ghShipGapReader(gh ?? defaultGh). */
  reader?: ShipGapReader;
  /** Injected gh; used only when reader is absent. */
  gh?: CloudGh;
  now?: () => Date;
}

const GH_TIMEOUT_MS = 60_000;
const GH_API_MAX_BYTES = 4 * 1024 * 1024;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: GH_API_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

type GhJson = { ok: true; value: unknown } | { ok: false; reason: string };

/** One read-only `gh api <endpoint>` GET returning parsed JSON. */
async function ghApiJson(gh: CloudGh, endpoint: string): Promise<GhJson> {
  const result = await gh(['api', endpoint]);
  if (!result.ok) {
    const detail = result.stderr.split('\n').map((line) => line.trim()).find(Boolean);
    return { ok: false, reason: `gh api ${endpoint} failed${detail ? ` (${detail.slice(0, 200)})` : ''}` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, reason: `gh api ${endpoint} did not return JSON` };
  }
}

/** v?MAJOR.MINOR.PATCH with an optional semver suffix. */
const VERSION_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)((?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * The highest version tag in a `gh api repos/{repo}/tags` page. A prerelease
 * suffix ranks below the same bare version; non-version tags never qualify.
 */
export function newestVersionTag(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  let best: { name: string; key: number[] } | null = null;
  for (const row of tags) {
    const name = (row as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') continue;
    const m = VERSION_TAG_RE.exec(name);
    if (!m) continue;
    const key = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === '' ? 1 : 0];
    if (best === null || lexGreater(key, best.key)) best = { name, key };
  }
  return best?.name ?? null;
}

/** Lexicographic a > b over equal-length version keys. */
function lexGreater(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * The production reader: three read-only `gh api` GETs per repo —
 * repo metadata (default branch), the tags page (newest version tag), then
 * compare (commits the branch is ahead of that tag plus the tag's own
 * commit date from base_commit).
 */
export function ghShipGapReader(gh: CloudGh): ShipGapReader {
  return async (repo) => {
    const meta = await ghApiJson(gh, `repos/${repo}`);
    if (!meta.ok) return meta;
    const defaultBranch = (meta.value as { default_branch?: unknown }).default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch === '') {
      return { ok: false, reason: `gh api repos/${repo} did not name a default branch` };
    }
    const tags = await ghApiJson(gh, `repos/${repo}/tags?per_page=100`);
    if (!tags.ok) return tags;
    const tag = newestVersionTag(tags.value);
    if (tag === null) {
      return { ok: false, reason: `${repo} has no version tags` };
    }
    const cmp = await ghApiJson(gh, `repos/${repo}/compare/${tag}...${defaultBranch}`);
    if (!cmp.ok) return cmp;
    const ahead = (cmp.value as { ahead_by?: unknown }).ahead_by;
    const taggedAt = (cmp.value as { base_commit?: { commit?: { committer?: { date?: unknown } } } })
      .base_commit?.commit?.committer?.date;
    if (typeof ahead !== 'number' || !Number.isSafeInteger(ahead) || ahead < 0) {
      return { ok: false, reason: `gh api compare for ${repo} did not report ahead_by` };
    }
    if (typeof taggedAt !== 'string' || Number.isNaN(Date.parse(taggedAt))) {
      return { ok: false, reason: `gh api compare for ${repo} did not report the tag's commit date` };
    }
    return { ok: true, tag, taggedAt, ahead };
  };
}

interface RepoShipGapRow {
  repo: string;
  status: 'ok' | 'unknown';
  tag: string | null;
  taggedAt: string | null;
  tagAgeDays: number | null;
  ahead: number | null;
  reason?: string;
}

export async function cmdFleetShipGap(args: string[], deps: FleetShipGapDeps = {}): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      console.log(`usage: ${FLEET_SHIP_GAP_USAGE}`);
      return 0;
    }
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    process.stderr.write(red('error: ') + `invalid fleet ship-gap argument: ${arg}\nusage: ${FLEET_SHIP_GAP_USAGE}\n`);
    return 2;
  }

  const reader = deps.reader ?? ghShipGapReader(deps.gh ?? defaultGh);
  const now = (deps.now ?? (() => new Date()))();
  const reads = await Promise.all(QUEUEGEN_REPOS.map(async (repo) => {
    try {
      return { repo, read: await reader(repo) };
    } catch (error) {
      return { repo, read: { ok: false as const, reason: `reader threw: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }));

  const repos: RepoShipGapRow[] = reads.map(({ repo, read }) => {
    if (!read.ok) {
      // Unknown means unread — never a fabricated zero drift.
      return { repo, status: 'unknown', tag: null, taggedAt: null, tagAgeDays: null, ahead: null, reason: read.reason };
    }
    const tagAgeDays = Math.max(0, Math.floor((now.getTime() - Date.parse(read.taggedAt)) / 86_400_000));
    return { repo, status: 'ok', tag: read.tag, taggedAt: read.taggedAt, tagAgeDays, ahead: read.ahead };
  });
  const unknown = repos.filter((row) => row.status === 'unknown').length;

  if (json) {
    console.log(JSON.stringify({
      v: 1,
      generatedAt: now.toISOString(),
      measured: repos.length - unknown,
      unknown,
      repos,
    }));
  } else {
    console.log(bold('Fleet ship-gap:') + ` ${repos.length - unknown}/${repos.length} repo(s) measured`);
    for (const row of repos) {
      if (row.status === 'ok') {
        console.log(`  ${row.repo.padEnd(28)} ${row.tag}  tagged ${row.tagAgeDays}d ago  ${row.ahead} commit(s) ahead`);
      } else {
        console.log(`  ${row.repo.padEnd(28)} ${red('unknown')}  ${dim(row.reason ?? '')}`);
      }
    }
    if (unknown > 0) {
      console.log(yellow(`${unknown} repo(s) could not be measured — drift is unread, not zero`));
    }
  }
  return unknown > 0 ? 1 : 0;
}
