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
 * Tag drift alone says nothing about users: a repo can be tagged v3.29.16
 * while npm still serves 3.29.15. Each row therefore also carries the npm
 * version (only where the repo's root package.json names a public package),
 * the conclusion of the latest scheduled CI run, and `live` — whether npm
 * has caught up with the newest tag. Those extra reads are best effort: a
 * failed one stays null (and `live` stays null) without failing the row.
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
  /** Version npm serves for the repo's package; null when no package or unread. */
  npmVersion?: string | null;
  /** Conclusion of the latest scheduled CI run; null when none or unread. */
  ciConclusion?: string | null;
}

export type ShipGapRead = ({ ok: true } & ShipGapTag) | { ok: false; reason: string };

/** One repo's drift read; the production implementation is ghShipGapReader. */
export type ShipGapReader = (repo: string) => Promise<ShipGapRead>;

export interface FleetShipGapDeps {
  /** Injected per-repo reader; defaults to ghShipGapReader(gh ?? defaultGh). */
  reader?: ShipGapReader;
  /** Injected gh; used only when reader is absent. */
  gh?: CloudGh;
  /** Injected read-only GET returning parsed JSON (npm registry); null on any failure. */
  getJson?: JsonGetter;
  now?: () => Date;
}

/** A read-only HTTP GET returning parsed JSON, or null on any failure. */
export type JsonGetter = (url: string) => Promise<unknown | null>;

const NPM_REGISTRY = 'https://registry.npmjs.org';

/** Production getter: global fetch, GET only, bounded by a timeout. */
const defaultGetJson: JsonGetter = async (url) => {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

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
    if (!VERSION_TAG_RE.test(name)) continue;
    const key = versionKey(name)!;
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
export function ghShipGapReader(gh: CloudGh, getJson: JsonGetter = defaultGetJson): ShipGapReader {
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
    const [npmVersion, ciConclusion] = await Promise.all([
      readNpmVersion(gh, getJson, repo),
      readScheduledCi(gh, repo),
    ]);
    return { ok: true, tag, taggedAt, ahead, npmVersion, ciConclusion };
  };
}

/**
 * The npm version of the package at the repo root, or null when the repo has
 * no public package or any read fails.
 */
async function readNpmVersion(gh: CloudGh, getJson: JsonGetter, repo: string): Promise<string | null> {
  const file = await ghApiJson(gh, `repos/${repo}/contents/package.json`);
  if (!file.ok) return null;
  const content = (file.value as { content?: unknown } | null)?.content;
  if (typeof content !== 'string') return null;
  let pkg: { name?: unknown; private?: unknown };
  try {
    pkg = JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (pkg.private === true || typeof pkg.name !== 'string' || pkg.name === '') return null;
  const meta = await getJson(`${NPM_REGISTRY}/${pkg.name.replace('/', '%2f')}/latest`);
  const version = (meta as { version?: unknown } | null)?.version;
  return typeof version === 'string' && VERSION_TAG_RE.test(version) ? version : null;
}

/** Conclusion of the newest scheduled workflow run; null when none or unread. */
async function readScheduledCi(gh: CloudGh, repo: string): Promise<string | null> {
  const runs = await ghApiJson(gh, `repos/${repo}/actions/runs?event=schedule&per_page=1`);
  if (!runs.ok) return null;
  const run = (runs.value as { workflow_runs?: unknown } | null)?.workflow_runs;
  const conclusion = Array.isArray(run) ? (run[0] as { conclusion?: unknown } | undefined)?.conclusion : null;
  return typeof conclusion === 'string' && conclusion !== '' ? conclusion : null;
}

/**
 * Whether npm has caught up with the newest tag: true when npm serves that
 * version or newer, false when the tag is ahead, null when npm is unknown.
 */
export function npmIsLive(tag: string, npmVersion: string | null | undefined): boolean | null {
  if (npmVersion == null) return null;
  const a = versionKey(tag);
  const b = versionKey(npmVersion);
  if (a === null || b === null) return null;
  return !lexGreater(a, b);
}

function versionKey(version: string): number[] | null {
  const m = VERSION_TAG_RE.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === '' ? 1 : 0] : null;
}

interface RepoShipGapRow {
  repo: string;
  status: 'ok' | 'unknown';
  tag: string | null;
  taggedAt: string | null;
  tagAgeDays: number | null;
  ahead: number | null;
  npmVersion: string | null;
  ciConclusion: string | null;
  /** Tag reached npm; null when the repo has no package or npm was unread. */
  live: boolean | null;
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

  const reader = deps.reader ?? ghShipGapReader(deps.gh ?? defaultGh, deps.getJson);
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
      return { repo, status: 'unknown', tag: null, taggedAt: null, tagAgeDays: null, ahead: null, npmVersion: null, ciConclusion: null, live: null, reason: read.reason };
    }
    const tagAgeDays = Math.max(0, Math.floor((now.getTime() - Date.parse(read.taggedAt)) / 86_400_000));
    const npmVersion = read.npmVersion ?? null;
    return {
      repo, status: 'ok', tag: read.tag, taggedAt: read.taggedAt, tagAgeDays, ahead: read.ahead,
      npmVersion, ciConclusion: read.ciConclusion ?? null, live: npmIsLive(read.tag, npmVersion),
    };
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
        const npm = row.npmVersion === null ? 'no npm' : `npm ${row.npmVersion}${row.live === false ? yellow(' (not live)') : ''}`;
        console.log(`  ${row.repo.padEnd(28)} ${row.tag}  tagged ${row.tagAgeDays}d ago  ${row.ahead} commit(s) ahead  ${npm}  ci ${row.ciConclusion ?? 'n/a'}`);
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
