/**
 * fleet_ci_resume_inputs — which CI jobs may reuse passing input-tree
 * receipts after a fix? A shell-free agent asks this through the isolated
 * fleet MCP server to serve the RESUME-FROM-FAILURE order without a shell,
 * a checkout path or workflow access. The manifest and prior-receipts
 * documents arrive inline as JSON objects — never file paths — and both
 * hexadecimal revisions are validated, so no caller cwd, filesystem path,
 * executable, environment or git option is ever accepted.
 *
 * Delegates to planCiResumeInputs — the same planner and digest algorithm
 * as `phm fleet ci-resume-inputs`, never a second digest — against the
 * server-owned repository cwd. The planner reads git objects only
 * (rev-parse, ls-tree, diff-tree); the working tree is never read, no
 * status or check is posted, no receipt is written and no workflow is
 * dispatched. Reuse stays advisory recorded evidence: a receipt counts
 * only when its stored digest is reproduced from objects at base, and
 * unknown or unmapped coverage remains a rerun.
 */
import {
  parseCiResumeManifest, parseCiResumePrior, planCiResumeInputs, type CiResumePlan,
} from '../core/fleet/ci-resume-inputs.js';
import type { GitRunner } from '../core/verse/git-ops.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Same per-document bound as the CLI's 1 MiB manifest/prior file cap. */
export const MAX_FLEET_CI_RESUME_INPUT_BYTES = 1024 * 1024;
const REV = /^[0-9a-f]{4,64}$/i;
const KEYS = new Set(['manifest', 'prior', 'base', 'head']);

export interface FleetCiResumeInputsArgs {
  /** Inline version-1 manifest document; a JSON object, never a file path. */
  manifest: unknown;
  /** Inline version-1 prior-receipts document; a JSON object, never a file path. */
  prior: unknown;
  /** Hexadecimal revision the prior attempt ran at. */
  base: string;
  /** Hexadecimal revision after the fix. */
  head: string;
}

export interface FleetCiResumeInputsDeps {
  /** Repository root the planner inspects; default the server process cwd (test seam). */
  cwd?: string;
  /** Git runner; default the production runner inside planCiResumeInputs (test seam). */
  git?: GitRunner;
}

export interface FleetCiResumeInputsV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  note: string;
  /** The shared planner's verdict, verbatim: per-job reuse/rerun, reasons and input digests. */
  plan: CiResumePlan;
}

const NOTE = 'Advisory reuse evidence only: each job decision is the shared ci-resume-inputs planner verdict over git objects at base and head — a receipt counts only when its stored inputs digest is reproduced from objects at base, unknown or unmapped coverage stays a rerun, and no decision is a live CI, dispatch or merge-queue reading. Read-only: this call read git objects only, posted no status or check, wrote no receipt, dispatched no workflow and mutated no CI.';

const boundedObject = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_FLEET_CI_RESUME_INPUT_BYTES; }
  catch { return false; }
};

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys
 * (including any caller cwd, path, root, ref, executable, environment or
 * git option), a missing or non-object manifest or prior document, a
 * serialized document over 1 MiB, a non-hexadecimal revision and any
 * manifest or prior the planner's own validators reject are all refused
 * before the reader — and before any git work — runs.
 */
export function parseFleetCiResumeInputsArgs(args: Record<string, unknown>): FleetCiResumeInputsArgs | null {
  const manifest = args['manifest'], prior = args['prior'], base = args['base'], head = args['head'];
  if (Object.keys(args).some((key) => !KEYS.has(key))
    || typeof base !== 'string' || !REV.test(base)
    || typeof head !== 'string' || !REV.test(head)
    || !boundedObject(manifest) || !boundedObject(prior)) return null;
  try {
    // The planner's own validators, reused — never a second schema.
    parseCiResumeManifest(manifest);
    parseCiResumePrior(prior);
  } catch {
    return null;
  }
  return { manifest, prior, base, head };
}

/**
 * One planner run at the server-owned repository cwd. Planner and git
 * failures propagate — the server reports them as a sanitized tool error,
 * never as a fabricated rerun-everything verdict. Only the plan crosses
 * this boundary, under the shared public-JSON scrub.
 */
export async function readFleetCiResumeInputs(
  input: FleetCiResumeInputsArgs,
  deps: FleetCiResumeInputsDeps = {},
): Promise<FleetCiResumeInputsV1> {
  const plan = await planCiResumeInputs({
    manifest: input.manifest, prior: input.prior, base: input.base, head: input.head,
    cwd: deps.cwd ?? process.cwd(), git: deps.git,
  });
  return sanitizePublicJson({
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(), note: NOTE, plan,
  }) as FleetCiResumeInputsV1;
}
