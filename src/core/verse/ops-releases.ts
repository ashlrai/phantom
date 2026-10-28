/**
 * core/verse/ops-releases.ts : read-only release status per enrolled repo,
 * for the Ops section's Releases view (`GET /api/verse/ops/releases`).
 *
 * Observational only: nothing here publishes, tags, deploys or mutates. Each
 * row reports the checked-out version, the newest local tag, the workflow
 * file that looks like the release pipeline, and : when `gh` can answer :
 * the latest published release and workflow run. `gh` unreachable is
 * UNKNOWN, never "no releases".
 *
 * I/O rules (scripts/check-verse-sync-io.mjs): project-folder reads go
 * through fs/promises under withFolderIo; git/gh run async, named as `git -C
 * <dir>` arguments with a neutral cwd, never spawned inside the folder.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { repoIdentityOfPath } from '../fleet/repo-identity.js';
import { scrubSecrets } from '../util/scrub.js';
import { mapLimited, withFolderIo } from './folder-io.js';
import type { OpsRepoReleaseV1 } from './ops-types.js';

const RELEASE_WORKFLOW_RE = /release|publish|deploy/i;
const GH_TIMEOUT_MS = 12_000;
const GIT_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 256 * 1024;

/** One command run to completion; null on any failure. Never throws. */
export type OpsRunner = (bin: string, args: readonly string[]) => Promise<string | null>;

/**
 * The production runner: execFile, neutral cwd (the folder is always an
 * argument, never the spawn's cwd), update/prompt notifiers off.
 */
const realRunner: OpsRunner = (bin, args) =>
  new Promise((resolveOut) => {
    try {
      execFile(bin, [...args], {
        cwd: homedir(),
        timeout: bin === 'gh' ? GH_TIMEOUT_MS : GIT_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: MAX_JSON_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GH_HOST: 'github.com',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PROMPT_DISABLED: '1',
          NO_COLOR: '1',
        },
      }, (err, stdout) => {
        resolveOut(err || typeof stdout !== 'string' ? null : stdout.trim());
      });
    } catch {
      resolveOut(null);
    }
  });

export interface OpsReleaseProbeDeps {
  /** `git`/`gh` runner; tests inject fixtures. */
  run?: OpsRunner;
  /** owner/name for a checkout path; tests inject. */
  identity?: (path: string) => string | null;
}

async function readPackageVersion(path: string): Promise<string | null> {
  const text = await withFolderIo(() => readFile(join(path, 'package.json'), 'utf8')).catch(() => null);
  if (!text) return null;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version.slice(0, 64) : null;
  } catch {
    return null;
  }
}

async function findReleaseWorkflow(path: string): Promise<string | null> {
  const names = await withFolderIo(() => readdir(join(path, '.github', 'workflows'))).catch(() => null);
  if (!names) return null;
  const hit = names.filter((n) => /\.(ya?ml)$/i.test(n) && RELEASE_WORKFLOW_RE.test(n)).sort()[0];
  return hit ?? null;
}

/** Newest tag the checkout knows: `describe --tags` nearest tag, else the highest version-sorted tag. */
async function latestTag(path: string, run: OpsRunner): Promise<string | null> {
  const described = await run('git', ['-C', path, 'describe', '--tags', '--abbrev=0']);
  if (described) return described.slice(0, 120);
  const list = await run('git', ['-C', path, 'tag', '--sort=-version:refname', '--list']);
  const first = list?.split('\n').map((l) => l.trim()).find(Boolean);
  return first ? first.slice(0, 120) : null;
}

interface GhRelease { tagName?: unknown; name?: unknown; publishedAt?: unknown; isDraft?: unknown; isPrerelease?: unknown }
interface GhRun { status?: unknown; conclusion?: unknown; createdAt?: unknown; displayTitle?: unknown }
type GhReleaseInfo = NonNullable<OpsRepoReleaseV1['gh']>['latestRelease'];
type GhRunInfo = NonNullable<OpsRepoReleaseV1['gh']>['latestRun'];

function firstJsonRow(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const list = JSON.parse(raw) as unknown;
    const row = Array.isArray(list) ? list[0] : null;
    return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function ghRelease(repo: string, run: OpsRunner): Promise<GhReleaseInfo> {
  const row = firstJsonRow(await run('gh', ['release', 'list', '-R', repo, '-L', '1', '--json', 'tagName,name,publishedAt,isDraft,isPrerelease'])) as GhRelease | null;
  if (!row || typeof row.tagName !== 'string') return null;
  return {
    tag: row.tagName.slice(0, 120),
    name: typeof row.name === 'string' ? row.name.slice(0, 160) : null,
    publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : null,
    draft: row.isDraft === true,
    prerelease: row.isPrerelease === true,
  };
}

async function ghRun(repo: string, workflow: string, run: OpsRunner): Promise<GhRunInfo> {
  const row = firstJsonRow(await run('gh', ['run', 'list', '-R', repo, '-w', workflow, '-L', '1', '--json', 'status,conclusion,createdAt,displayTitle'])) as GhRun | null;
  if (!row) return null;
  return {
    workflow,
    status: typeof row.status === 'string' ? row.status.slice(0, 40) : 'unknown',
    conclusion: typeof row.conclusion === 'string' ? row.conclusion.slice(0, 40) : null,
    at: typeof row.createdAt === 'string' ? row.createdAt : null,
  };
}

/** Read one repo's release posture. Never throws; every field degrades to null on its own. */
export async function probeRepoRelease(path: string, deps: OpsReleaseProbeDeps = {}): Promise<OpsRepoReleaseV1> {
  const run = deps.run ?? realRunner;
  const identity = deps.identity ?? repoIdentityOfPath;
  const notes: string[] = [];
  const nwo = (() => { try { return identity(path); } catch { return null; } })();
  const repo = nwo ?? basename(path);

  const [version, tag, workflow] = await Promise.all([
    readPackageVersion(path),
    latestTag(path, run),
    findReleaseWorkflow(path),
  ]);
  if (version === null && tag === null) notes.push('No package version or git tags could be read.');
  if (!workflow) notes.push('No release workflow found in this checkout.');

  let gh: OpsRepoReleaseV1['gh'] = null;
  if (nwo) {
    const [release, runRow] = await Promise.all([
      ghRelease(nwo, run).catch(() => null),
      workflow ? ghRun(nwo, workflow, run).catch(() => null) : Promise.resolve(null),
    ]);
    // A null gh answer means gh could not say : distinguishable from "no release yet".
    const ghAnswered = release !== null || runRow !== null
      || (await run('gh', ['release', 'list', '-R', nwo, '-L', '1', '--json', 'tagName'])) !== null;
    gh = ghAnswered ? { latestRelease: release, latestRun: runRow } : null;
    if (!gh) notes.push('gh could not answer: it may be missing, unauthenticated, or offline.');
  } else {
    notes.push('No GitHub origin could be proven for this checkout.');
  }

  return {
    repo: scrubSecrets(repo).slice(0, 140),
    path,
    version,
    latestTag: tag ? scrubSecrets(tag).slice(0, 120) : null,
    releaseWorkflow: workflow,
    gh,
    notes: notes.map((n) => scrubSecrets(n).slice(0, 200)),
  };
}

/** Releases for every enrolled path, in order, under the folder-IO cap. Never throws. */
export async function probeReleases(paths: readonly string[], deps: OpsReleaseProbeDeps = {}): Promise<OpsRepoReleaseV1[]> {
  return mapLimited([...new Set(paths)], 2, (path) =>
    probeRepoRelease(path, deps).catch((): OpsRepoReleaseV1 => ({
      repo: basename(path),
      path,
      version: null,
      latestTag: null,
      releaseWorkflow: null,
      gh: null,
      notes: ['This checkout could not be read.'],
    })),
  );
}
