/**
 * Agent Bus v2 contract (docs/AGENT-BUS.md, "v2"). Schemas and pure rules only:
 * no I/O, no runtime wiring. Claims coordinate; they grant no execution authority.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const AGENT_BUS_V2_VERSION = 'agent-bus.v2';
export const CLAIM_MIN_LEASE_MS = 1;
export const CLAIM_MAX_LEASE_MS = 3_600_000;
export const BUS_V2_TEXT_MAX = 16_384;

export const PROVIDERS = [
  'grokbot', 'openai-dot', 'codex-cmp', 'codex-personal', 'devin',
  'cursor-cloud', 'claude', 'glm', 'stacksync', 'local',
] as const;
export const WAKE_KINDS = ['poll', 'webhook', 'email'] as const;
export const PARTICIPANT_STATUSES = ['active', 'idle', 'offline', 'disabled'] as const;
export const WORK_STATUSES = [
  'queued', 'running', 'idle', 'rescheduled', 'blocked', 'done', 'failed', 'terminated',
] as const;
export const BODY_KINDS = [
  'note', 'context', 'work.post', 'work.claim', 'work.status', 'work.release', 'wake',
] as const;

/** Same shape as v1 routing labels: printable ASCII, 1-128 chars. */
const label = z.string().regex(/^[\x21-\x7e]{1,128}$/, 'printable ASCII label, 1-128 chars');
/** A wake target is a name, never a URL or credential: no scheme, query, userinfo or long opaque runs. */
const wakeTarget = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'label only: letters, digits, . _ : -')
  .refine((s) => !/[A-Za-z0-9]{32,}/.test(s), 'looks like a secret, not a label');
const repoSlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name');
const text = z.string().min(1).max(BUS_V2_TEXT_MAX);
const epochMs = z.number().int().nonnegative().safe();
const leaseMs = z.number().int().min(CLAIM_MIN_LEASE_MS).max(CLAIM_MAX_LEASE_MS);
const claimToken = z.string().regex(/^[a-f0-9]{64}$/, '64 lowercase hex chars');

export const providerSchema = z.enum(PROVIDERS);

export const participantSchema = z.object({
  participantId: label,
  provider: providerSchema,
  displayName: z.string().trim().min(1).max(128),
  capabilities: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)).max(32),
  wake: z.object({ kind: z.enum(WAKE_KINDS), target: wakeTarget }).strict(),
  status: z.enum(PARTICIPANT_STATUSES),
}).strict();
export type Participant = z.infer<typeof participantSchema>;

// ─── Claim keys ─────────────────────────────────────────────────────

export type ParsedClaimKey =
  | { kind: 'repo'; repo: string }
  | { kind: 'path'; repo: string; glob: string }
  | { kind: 'queue'; queue: string }
  | { kind: 'pr'; repo: string; number: number };

const REPO = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';

/** Parse a resource claim key; undefined when malformed. Repo names compare case-insensitively. */
export function parseClaimKey(key: string): ParsedClaimKey | undefined {
  let m = new RegExp(`^repo:(${REPO})$`).exec(key);
  if (m) return { kind: 'repo', repo: m[1]!.toLowerCase() };
  m = new RegExp(`^path:(${REPO}):([^\\0]{1,256})$`).exec(key);
  if (m) {
    const glob = m[2]!;
    if (glob.startsWith('/') || glob.split('/').includes('..') || /[\x00-\x1f]/.test(glob)) return undefined;
    return { kind: 'path', repo: m[1]!.toLowerCase(), glob };
  }
  m = /^queue:([\x21-\x7e]{1,128})$/.exec(key);
  if (m) return { kind: 'queue', queue: m[1]! };
  m = new RegExp(`^pr:(${REPO})#([1-9][0-9]{0,8})$`).exec(key);
  if (m) return { kind: 'pr', repo: m[1]!.toLowerCase(), number: Number(m[2]) };
  return undefined;
}

export const claimKeySchema = z.string().refine((k) => parseClaimKey(k) !== undefined, 'invalid claim key');

/** Literal prefix of a glob: everything before the first wildcard character. */
export function literalPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Minimal glob match: `**` any chars, `*` any but `/`, `?` one non-`/` char. */
export function globMatches(glob: string, subject: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(subject);
}

function pathGlobsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const hit = (glob: string, other: string): boolean => {
    const p = literalPrefix(other);
    return globMatches(glob, p) || globMatches(glob, p.endsWith('/') ? p : `${p}/`);
  };
  return hit(a, b) || hit(b, a);
}

/** Pure overlap rule. A repo claim overlaps any path claim in that repo; other kinds never cross. */
export function claimKeysOverlap(a: string, b: string): boolean {
  const x = parseClaimKey(a), y = parseClaimKey(b);
  if (!x || !y) return false;
  if (x.kind === 'repo') return (y.kind === 'repo' || y.kind === 'path') && y.repo === x.repo;
  if (y.kind === 'repo') return x.kind === 'path' && x.repo === y.repo;
  if (x.kind === 'path' && y.kind === 'path') return x.repo === y.repo && pathGlobsOverlap(x.glob, y.glob);
  if (x.kind === 'queue' && y.kind === 'queue') return x.queue === y.queue;
  if (x.kind === 'pr' && y.kind === 'pr') return x.repo === y.repo && x.number === y.number;
  return false;
}

// ─── Claims ─────────────────────────────────────────────────────────

export const claimSchema = z.object({
  claimKey: claimKeySchema,
  owner: label,
  leaseMs,
  token: claimToken,
  leaseUntil: epochMs,
}).strict();
export type Claim = z.infer<typeof claimSchema>;

/** What a 409 shows the loser: who holds it and until when. Never the holder's token. */
export const claimConflictSchema = z.object({
  v: z.literal(2),
  status: z.literal('conflict'),
  holder: z.object({ owner: label, claimKey: claimKeySchema, leaseUntil: epochMs }).strict(),
}).strict();
export type ClaimConflict = z.infer<typeof claimConflictSchema>;

/** Expired claims are free: live only while now < leaseUntil. */
export function claimIsLive(claim: Pick<Claim, 'leaseUntil'>, now: number): boolean {
  return now < claim.leaseUntil;
}

/** First live claim overlapping `claimKey`, or undefined when acquire may proceed (else 409 + holder). */
export function findClaimConflict(
  existing: readonly Claim[], claimKey: string, now: number,
): ClaimConflict['holder'] | undefined {
  for (const c of existing) {
    if (claimIsLive(c, now) && claimKeysOverlap(c.claimKey, claimKey)) {
      return { owner: c.owner, claimKey: c.claimKey, leaseUntil: c.leaseUntil };
    }
  }
  return undefined;
}

/** Only the live claim's token holder may renew, release or complete. Constant-time compare. */
export function mayMutateClaim(claim: Claim, presentedToken: string, now: number): boolean {
  if (!claimIsLive(claim, now) || !claimToken.safeParse(presentedToken).success) return false;
  return timingSafeEqual(Buffer.from(claim.token), Buffer.from(presentedToken));
}

// ─── Body kinds (inside envelope.body.kind) ─────────────────────────

const refs = z.array(z.string().min(1).max(256)).max(32);
const jobId = label;

export const noteBodySchema = z.object({
  kind: z.literal('note'), text, thread: label.optional(), refs: refs.optional(),
}).strict();
export const contextBodySchema = z.object({
  kind: z.literal('context'), text, thread: label.optional(), refs: refs.optional(),
}).strict();
export const workPostBodySchema = z.object({
  kind: z.literal('work.post'), jobId, title: z.string().min(1).max(256), provider: providerSchema.optional(),
  repo: repoSlug, claimKeys: z.array(claimKeySchema).max(16),
}).strict();
export const workClaimBodySchema = z.discriminatedUnion('op', [
  z.object({ kind: z.literal('work.claim'), op: z.literal('acquire'), jobId: jobId.optional(),
    claimKey: claimKeySchema, owner: label, leaseMs }).strict(),
  z.object({ kind: z.literal('work.claim'), op: z.literal('renew'), claimKey: claimKeySchema,
    token: claimToken, leaseMs }).strict(),
]);
export const workStatusBodySchema = z.object({
  kind: z.literal('work.status'), jobId, status: z.enum(WORK_STATUSES), detail: text.max(1024).optional(),
}).strict();
export const workReleaseBodySchema = z.object({
  kind: z.literal('work.release'), claimKey: claimKeySchema, token: claimToken,
  outcome: z.enum(['released', 'completed']),
}).strict();
export const wakeBodySchema = z.object({
  kind: z.literal('wake'), target: label, reason: text.max(512), jobId: jobId.optional(),
}).strict();

/** Validates `envelope.body` for v2 messages. v1 bodies without a v2 kind stay valid v1 bodies. */
export const busBodySchema = z.union([
  noteBodySchema, contextBodySchema, workPostBodySchema, workClaimBodySchema,
  workStatusBodySchema, workReleaseBodySchema, wakeBodySchema,
]);
export type BusBody = z.infer<typeof busBodySchema>;

// ─── Work feed ──────────────────────────────────────────────────────

export const workJobSchema = z.object({
  id: jobId,
  owner: label,
  provider: providerSchema,
  repo: repoSlug,
  claimKeys: z.array(claimKeySchema).max(16),
  status: z.enum(WORK_STATUSES),
  updatedAt: epochMs,
}).strict();
export type WorkJob = z.infer<typeof workJobSchema>;

export const workFeedSchema = z.object({
  v: z.literal(2),
  jobs: z.array(workJobSchema).max(1024),
}).strict();

// ─── Contract summary (for `ashlr agents bus contract`) ─────────────

export function busV2ContractSummary() {
  return {
    schemaVersion: AGENT_BUS_V2_VERSION,
    providers: [...PROVIDERS],
    wakeKinds: [...WAKE_KINDS],
    bodyKinds: [...BODY_KINDS],
    workStatuses: [...WORK_STATUSES],
    claimKeyForms: ['repo:<owner/name>', 'path:<owner/name>:<glob>', 'queue:<queue id>', 'pr:<owner/name>#<n>'],
    claimLeaseMs: { min: CLAIM_MIN_LEASE_MS, max: CLAIM_MAX_LEASE_MS },
    claimsGrantExecutionAuthority: false,
  } as const;
}
