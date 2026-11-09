/**
 * fleet_release_candidate — read-only release-candidate diagnostics for the
 * isolated fleet MCP server, so a shell-free release supervisor can inspect
 * the exact candidate, the gate artifact and the master-moved blocker behind
 * a stuck release. Delegates to the same planReleaseCandidate planner as
 * `ashlr fleet release-candidate` — never a second release implementation —
 * and sanitizes the plan through the shared public-JSON helper. Evidence is
 * gathered live from bounded `gh api` reads of the named repository: this is
 * remote observation, not local persisted state, and no attestation,
 * signing, tag or dispatch behavior changes. nextActions stay advisory text;
 * the tool never executes the commands they describe.
 */
import { planReleaseCandidate, type ReleaseCandidatePlan } from '../core/fleet/release-candidate-plan.js';
import type { GitRunner } from '../core/verse/git-ops.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Same accept rules as `ashlr fleet release-candidate --repo`. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Strict semver release tag: vX.Y.Z, no leading zeros, no suffix. */
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export const FLEET_RELEASE_CANDIDATE_REPO_PATTERN = REPO.source;
export const FLEET_RELEASE_CANDIDATE_TAG_PATTERN = TAG.source;

export interface FleetReleaseCandidateArgs {
  /** Exact GitHub repository 'owner/name' the release candidate lives in. */
  repo: string;
  /** Exact semver release tag such as v3.30.7. */
  tag: string;
}

export interface FleetReleaseCandidateDeps {
  /** Planner; default planReleaseCandidate (test seam). */
  plan?: typeof planReleaseCandidate;
  /** Runner handed to the planner for its `gh api` reads (test seam). */
  runner?: GitRunner;
}

export interface FleetReleaseCandidateReport {
  schemaVersion: 1;
  /** Live remote API evidence — deliberately not 'local-persisted'. */
  snapshotKind: 'remote-api';
  authority: 'none';
  generatedAt: string;
  /** Bounded-evidence caveat; fixed text. */
  note: string;
  /** The shared planner output, sanitized; every state and null preserved. */
  plan: ReleaseCandidatePlan;
}

const NOTE = 'Bounded live evidence from gh api reads of the named repository: the tag commit and tree, the current master head, the ci.yml gate run on the candidate, attest-ci-build.yml run facts, the immutable producer artifact and the release row. Missing or ambiguous evidence stays unknown or unavailable — never labeled ready — and masterMoved/treeMatch stay null while either side is unreadable. A published release row is GitHub release state only, distinct from any installed-app state. Advisory nextActions are never executed; this tool never dispatches, signs, tags, merges or mutates anything.';

const RELEASE_CANDIDATE_KEYS = new Set(['repo', 'tag']);

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys —
 * including any caller-supplied sha, ref, runner, path, root or cwd — are
 * rejected before the planner runs, and repo/tag must satisfy the same
 * strict patterns the CLI enforces. Tag mode only: the planner's
 * candidate-sha inspection is deliberately not a public argument.
 */
export function parseFleetReleaseCandidateArgs(args: Record<string, unknown>): FleetReleaseCandidateArgs | null {
  const repo = args['repo'], tag = args['tag'];
  if (Object.keys(args).some(key => !RELEASE_CANDIDATE_KEYS.has(key)) ||
    typeof repo !== 'string' || typeof tag !== 'string' ||
    !REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--') ||
    repo.endsWith('/.') || repo.endsWith('/..') || !TAG.test(tag)) return null;
  return { repo, tag };
}

/**
 * Delegates to planReleaseCandidate verbatim — outcome, candidate and master
 * SHAs/trees, gate and attest run facts, producer-artifact identity, release
 * state, blockers and nextActions all cross unchanged, then the whole report
 * passes the shared public-JSON scrub. Planner failures propagate so the
 * server reports a sanitized tool error, never a fabricated verdict.
 */
export async function readFleetReleaseCandidate(
  input: FleetReleaseCandidateArgs,
  deps: FleetReleaseCandidateDeps = {},
): Promise<FleetReleaseCandidateReport> {
  const plan = await (deps.plan ?? planReleaseCandidate)(input.repo, input.tag, { runner: deps.runner });
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'remote-api', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE, plan,
  }) as FleetReleaseCandidateReport;
}
