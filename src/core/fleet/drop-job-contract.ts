/**
 * core/fleet/drop-job-contract.ts: the pure half of the drop-job contract.
 *
 * Constants, header builder and validator that mirror the host ingest
 * (`~/.ashlr-runs/bin/orch-ingest.py`). No Node imports, so the browser
 * (mobile drop-job model) and the server (drop-job-writer.ts) share ONE copy.
 * `phm doctor` (ingest-drift.ts) compares these against the host file.
 */

export const DROP_JOB_LANES = ['claude', 'codex-personal', 'devin', 'codex-local'] as const;
export const DROP_JOB_TIERS = ['frontier', 'work', 'mid', 'fast'] as const;
export type DropJobLane = (typeof DROP_JOB_LANES)[number];
export type DropJobTier = (typeof DROP_JOB_TIERS)[number];

const LANES = new Set<string>(DROP_JOB_LANES);
const TIERS = new Set<string>(DROP_JOB_TIERS);

/** The id after `RQ-PHX-`. */
export const DROP_JOB_ID = /^[A-Z0-9]{3,40}$/;
/** A drop/queue file name carrying a valid id. */
export const DROP_JOB_FILE = /^RQ-PHX-([A-Z0-9]{3,40})\.md$/;
export const DROP_JOB_FILE_PREFIX = 'RQ-PHX-';

/** Whole file, header included — the ingest's hard ceiling. */
export const DROP_JOB_MAX_FILE_BYTES = 8000;

/** Repos a drop job may name in its header. `phantom` is the default. */
export const DROP_JOB_REPOS: readonly string[] = ['phantom', 'phantom-secrets', 'ashlr-plugin', 'ashlr-stack', 'locus', 'lexicon', 'ashlr-md'];
export const DROP_JOB_DEFAULT_REPO = 'phantom';
/**
 * The host ingest's own patterns (orch-ingest.py), copied verbatim as the one
 * fixture-able statement of the contract. validateDropJob proves every job it
 * accepts also matches these, so a writer cannot emit what the ingest drops.
 */
export const INGEST_JOB_ID = /^RQ-PHX-[A-Z0-9]{3,40}$/;
export const INGEST_JOB_FILE = /^RQ-PHX-[A-Z0-9]{3,40}\.md$/;
export const INGEST_JOB_HEADER = /^#job repo=(phantom|phantom-secrets|ashlr-plugin|ashlr-stack|locus|lexicon|ashlr-md) lane=(\S+) tier=(\S+)\s*$/;
/** The denied-body tokens the ingest rejects on, spelled out once. */
const DENIED_TOKENS = ['.github/', '/.codex', 'auth.json', 'CODEOWNERS'] as const;
const DENIED_CONTENT = new RegExp(
  DENIED_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
);

/** Newline and tab are the only control characters a body may carry. */
const CONTROL_BESIDES_NL_TAB = /(?![\n\t])\p{Cc}/u;

export interface DropJobInput {
  id: string;
  /** Repo named in the header; one of DROP_JOB_REPOS. Defaults to phantom. */
  repo?: string;
  lane: string;
  tier: string;
  body: string;
}

export type DropJobValidation = { ok: true } | { ok: false; reasons: string[] };

/** `#job repo=<repo> lane=<lane> tier=<tier>` — ingest demands this as line 1. */
export function dropJobHeader(lane: string, tier: string, repo: string = DROP_JOB_DEFAULT_REPO): string {
  return `#job repo=${repo} lane=${lane} tier=${tier}`;
}

/** Header line, blank line, body, trailing newline — the on-disk shape. */
export function composeDropJobFile(input: Pick<DropJobInput, 'lane' | 'tier' | 'body' | 'repo'>): string {
  return `${dropJobHeader(input.lane, input.tier, input.repo)}\n\n${input.body}\n`;
}

/**
 * Mirrors the ingest's accept list. Every failure names a machine reason:
 * `id-shape`, `lane`, `tier`, `empty-body`, `control-characters`,
 * `denied-content`, `too-large`, `repo` (not one of DROP_JOB_REPOS).
 */
export function validateDropJob(input: { id: unknown; repo?: unknown; lane: unknown; tier: unknown; body: unknown }): DropJobValidation {
  const reasons: string[] = [];
  if (typeof input.id !== 'string' || !DROP_JOB_ID.test(input.id)) reasons.push('id-shape');
  if (input.repo !== undefined && (typeof input.repo !== 'string' || !DROP_JOB_REPOS.includes(input.repo))) reasons.push('repo');
  if (typeof input.lane !== 'string' || !LANES.has(input.lane)) reasons.push('lane');
  if (typeof input.tier !== 'string' || !TIERS.has(input.tier)) reasons.push('tier');
  const body = input.body;
  if (typeof body !== 'string' || body.trim() === '') {
    reasons.push('empty-body');
  } else {
    if (CONTROL_BESIDES_NL_TAB.test(body)) reasons.push('control-characters');
    if (DENIED_CONTENT.test(body)) reasons.push('denied-content');
  }
  // Shape of what would land on disk, checked against the ingest's own patterns.
  if (typeof input.id === 'string' && DROP_JOB_ID.test(input.id)) {
    const name = `${DROP_JOB_FILE_PREFIX}${input.id}.md`;
    if (!INGEST_JOB_ID.test(`${DROP_JOB_FILE_PREFIX}${input.id}`) || !INGEST_JOB_FILE.test(name)) reasons.push('file-name');
  }
  if (typeof input.lane === 'string' && typeof input.tier === 'string') {
    const header = dropJobHeader(input.lane, input.tier, typeof input.repo === 'string' ? input.repo : undefined);
    const parsed = INGEST_JOB_HEADER.exec(header);
    if (!parsed || !LANES.has(parsed[2]!) || !TIERS.has(parsed[3]!)) {
      if (!reasons.some((r) => r === 'repo' || r === 'lane' || r === 'tier')) reasons.push('header');
    }
  }
  if (typeof input.lane === 'string' && typeof input.tier === 'string' && typeof body === 'string'
    && new TextEncoder().encode(composeDropJobFile({ lane: input.lane, tier: input.tier, body, repo: typeof input.repo === 'string' ? input.repo : undefined })).length > DROP_JOB_MAX_FILE_BYTES) {
    reasons.push('too-large');
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

const REASON_WORDS: Record<string, string> = {
  'id-shape': 'the job id must be 3 to 40 capital letters or digits after RQ-PHX-',
  repo: `the repo must be one of ${DROP_JOB_REPOS.join(', ')}`,
  lane: `the lane must be one of ${DROP_JOB_LANES.join(', ')}`,
  tier: `the tier must be one of ${DROP_JOB_TIERS.join(', ')}`,
  'file-name': 'the file name must be RQ-PHX-<id>.md',
  header: 'the first line must be "#job repo=<repo> lane=<lane> tier=<tier>"',
  'empty-body': 'the job body is empty',
  'control-characters': 'the job body has control characters',
  'denied-content': 'the job body names a protected path',
  'too-large': `the job is over ${DROP_JOB_MAX_FILE_BYTES} bytes`,
};

/** Plain-words refusal for a failed validation: one sentence an operator can act on. */
export function explainDropJobReasons(reasons: readonly string[]): string {
  return `refused: ${reasons.map((r) => REASON_WORDS[r] ?? r).join('; ')}`;
}
