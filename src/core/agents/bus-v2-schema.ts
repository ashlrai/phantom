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
/** The dispatch tiers a `work.post` may declare, lightest first — the same values the queue tiers use. */
export const WORK_TIERS = ['fast', 'mid', 'work', 'frontier'] as const;
export const BODY_KINDS = [
  'note', 'context', 'work.post', 'work.claim', 'work.status', 'work.result', 'work.release', 'wake',
] as const;

/** Same shape as v1 routing labels: printable ASCII, 1-128 chars. */
const label = z.string().regex(/^[\x21-\x7e]{1,128}(?![\s\S])/, 'printable ASCII label, 1-128 chars');
/** A wake target is a name, never a URL or credential: no scheme, query, userinfo or long opaque runs. */
const wakeTarget = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/, 'label only: letters, digits, . _ : -')
  .refine((s) => !/[A-Za-z0-9]{32,}/.test(s), 'looks like a secret, not a label');
export const repoSlugSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/, 'owner/name');
const text = z.string().min(1).max(BUS_V2_TEXT_MAX);
const epochMs = z.number().int().nonnegative().safe();
const leaseMs = z.number().int().min(CLAIM_MIN_LEASE_MS).max(CLAIM_MAX_LEASE_MS);
const claimToken = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/, '64 lowercase hex chars');

export const providerSchema = z.enum(PROVIDERS);

export const participantSchema = z.object({
  participantId: label,
  provider: providerSchema,
  displayName: z.string().trim().min(1).max(128),
  capabilities: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}(?![\s\S])/)).max(32),
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

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20 || s.charCodeAt(i) === 0x7f || s.charCodeAt(i) === 0x2028 || s.charCodeAt(i) === 0x2029) return true;
  }
  return false;
}

/** Parse a resource claim key; undefined when malformed. Repo names compare case-insensitively. */
export function parseClaimKey(key: string): ParsedClaimKey | undefined {
  if (hasControl(key)) return undefined;
  let m = new RegExp(`^repo:(${REPO})(?![\\s\\S])`).exec(key);
  if (m) return { kind: 'repo', repo: m[1]!.toLowerCase() };
  m = new RegExp(`^path:(${REPO}):([^\\0]{1,256})(?![\\s\\S])`).exec(key);
  if (m) {
    const glob = m[2]!;
    if (glob.startsWith('/') || glob.split('/').includes('..')) return undefined;
    return { kind: 'path', repo: m[1]!.toLowerCase(), glob };
  }
  m = /^queue:([\x21-\x7e]{1,128})(?![\s\S])/.exec(key);
  if (m) return { kind: 'queue', queue: m[1]! };
  m = new RegExp(`^pr:(${REPO})#([1-9][0-9]{0,8})(?![\\s\\S])`).exec(key);
  if (m) return { kind: 'pr', repo: m[1]!.toLowerCase(), number: Number(m[2]) };
  return undefined;
}

export const claimKeySchema = z.string().refine((k) => parseClaimKey(k) !== undefined, 'invalid claim key');

/** Literal prefix of a glob: everything before the first wildcard character.
 * `globMatches` treats only `*` and `?` as wildcards — `[`, `{` and the rest
 * are literal, so they never end the prefix. */
export function literalPrefix(glob: string): string {
  const i = glob.search(/[*?]/);
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

// ─── Glob intersection ──────────────────────────────────────────────
// pathGlobsOverlap must answer "does some path match both globs" exactly:
// the coordination table treats a false as proof two claims are disjoint,
// so a missed intersection lets two live claims cover the same paths.

type GlobAtom =
  | { kind: 'lit'; ch: string }
  | { kind: 'seg' }        // `?` — exactly one non-`/` char
  | { kind: 'star-seg' }   // `*` — any run of non-`/` chars
  | { kind: 'star-any' };  // `**` — any run of chars

/** Compile a glob to the atoms globMatches consumes: `**`→`.*`, `*`→`[^/]*`, `?`→`[^/]`, else literal. */
function globAtoms(glob: string): GlobAtom[] {
  const atoms: GlobAtom[] = [];
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { atoms.push({ kind: 'star-any' }); i += 1; }
      else atoms.push({ kind: 'star-seg' });
    } else atoms.push(c === '?' ? { kind: 'seg' } : { kind: 'lit', ch: c });
  }
  return atoms;
}

type ConsumeClass = { t: 'lit'; ch: string } | { t: 'seg' } | { t: 'any' };

function atomClass(atom: GlobAtom): ConsumeClass {
  switch (atom.kind) {
    case 'lit': return { t: 'lit', ch: atom.ch };
    case 'seg':
    case 'star-seg': return { t: 'seg' };
    case 'star-any': return { t: 'any' };
  }
}

/** Whether one consumed character can satisfy both classes at once. */
function classesMeet(a: ConsumeClass, b: ConsumeClass): boolean {
  if (a.t === 'any' || b.t === 'any') return true;
  if (a.t === 'seg') return b.t === 'seg' || b.ch !== '/';
  if (b.t === 'seg') return a.ch !== '/';
  return a.ch === b.ch;
}

const isStarAtom = (atom: GlobAtom): boolean => atom.kind === 'star-seg' || atom.kind === 'star-any';

/**
 * Exact intersection of two globs under globMatches semantics, by product
 * construction over their atom NFAs: a state is the pair of next-atom
 * positions, star atoms may consume their class and stay or be skipped, and
 * every other atom consumes one character and advances. Both sides must
 * consume the same character, so classes must intersect. O(len(a)·len(b)).
 */
function globLanguagesIntersect(a: string, b: string): boolean {
  const left = globAtoms(a), right = globAtoms(b);
  const width = right.length + 1;
  const seen = new Uint8Array((left.length + 1) * width);
  const queue: number[] = [0];
  seen[0] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head]!;
    const i = Math.floor(state / width), j = state % width;
    if (i === left.length && j === right.length) return true;
    if (i < left.length && isStarAtom(left[i]!) && !seen[state + width]) { seen[state + width] = 1; queue.push(state + width); }
    if (j < right.length && isStarAtom(right[j]!) && !seen[state + 1]) { seen[state + 1] = 1; queue.push(state + 1); }
    if (i < left.length && j < right.length && classesMeet(atomClass(left[i]!), atomClass(right[j]!))) {
      const ni = isStarAtom(left[i]!) ? i : i + 1;
      const nj = isStarAtom(right[j]!) ? j : j + 1;
      const next = ni * width + nj;
      if (!seen[next]) { seen[next] = 1; queue.push(next); }
    }
  }
  return false;
}

function pathGlobsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  // A wildcard-free side is one concrete subject: a single globMatches decides.
  if (!/[*?]/.test(a)) return globMatches(b, a);
  if (!/[*?]/.test(b)) return globMatches(a, b);
  return globLanguagesIntersect(a, b);
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

/**
 * `inReplyTo` cites the envelope id a conversational body answers — the same
 * citation `postBusReply`, `comms bus post --reply-to` and the fleet reply
 * verbs stamp, which `busReplyCitations`, the conversation projection and the
 * pending-work sections already credit. It is a routing label, never proof
 * the cited message existed or was received.
 */
const replyCitation = { inReplyTo: label.optional() } as const;
export const noteBodySchema = z.object({
  kind: z.literal('note'), text, thread: label.optional(), refs: refs.optional(),
  ...replyCitation,
}).strict();
export const contextBodySchema = z.object({
  kind: z.literal('context'), text, thread: label.optional(), refs: refs.optional(),
  ...replyCitation,
}).strict();
/** The optional dispatch spec a work.post may carry; the feed job keeps it verbatim. */
export const workDispatchSchema = z.object({
  tier: z.enum(WORK_TIERS),
  scope: text.max(4000), acceptance: text.max(2000),
}).strict();
export type WorkDispatch = z.infer<typeof workDispatchSchema>;

export const workPostBodySchema = z.object({
  kind: z.literal('work.post'), jobId, title: z.string().min(1).max(256), provider: providerSchema.optional(),
  repo: repoSlugSchema, claimKeys: z.array(claimKeySchema).max(16),
  dispatch: workDispatchSchema.optional(),
}).strict();
export const workResultBodySchema = z.object({
  kind: z.literal('work.result'), jobId, claimKey: claimKeySchema,
  queueId: z.string().regex(/^peer-work-[a-f0-9]{32}$/),
  receiptId: z.string().regex(/^pw-[a-f0-9]{32}$/),
  outcome: z.enum(['reserved', 'admitted', 'complete', 'failed']),
  reason: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
}).strict();
/** The outcome codes a `work.result` body reports — reported evidence a
 * worker/peer posted, never a feed job status. */
export type WorkResultOutcome = z.infer<typeof workResultBodySchema>['outcome'];
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
  workStatusBodySchema, workResultBodySchema, workReleaseBodySchema, wakeBodySchema,
]);
export type BusBody = z.infer<typeof busBodySchema>;

/**
 * The conversation label a `note`/`context` body carries in `thread`, or null
 * for every other body kind and shape. Thread reads match this field only: it
 * is the one v2 body field that ties a question and its answer together.
 */
export function busBodyThread(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record['kind'] !== 'note' && record['kind'] !== 'context') return null;
  const thread = record['thread'];
  return typeof thread === 'string' && thread.length > 0 ? thread : null;
}

/**
 * The kind discriminator a retained body carries — the same discriminator
 * `busBodySummary` switches on, read verbatim and unvalidated: the v2 `kind`
 * field (`note`, `context`, `work.post`, `work.claim`, `work.status`,
 * `work.result`, `work.release`, `wake`), a `worker-handoff` assignment or a
 * notice kind that shares the store; failing that, the `protocol.kind` a
 * bus-transport v1 envelope wraps, then the `type`/`schema` discriminator the
 * kindless notices key on. A body carrying none of those fields returns null
 * and never matches a body-kind filter. The match is exact and
 * case-sensitive like every other own-field bus filter — an unrecognized but
 * printable value is an honest empty match, never an error and never a
 * widened one.
 */
export function busBodyKind(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const field = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };
  const kind = field('kind');
  if (kind !== null) return kind;
  const proto = record['protocol'];
  if (proto !== null && typeof proto === 'object' && !Array.isArray(proto)) {
    const pk = (proto as Record<string, unknown>)['kind'];
    if (typeof pk === 'string' && pk.trim()) return pk;
  }
  return field('type') ?? field('schema');
}

// ─── Work feed ──────────────────────────────────────────────────────

export const workJobSchema = z.object({
  id: jobId,
  owner: label,
  /** Routing label the work.post announcement was addressed to. */
  to: label,
  provider: providerSchema,
  repo: repoSlugSchema,
  /** The announcement's own title and optional dispatch spec, carried so the feed names the work. */
  title: z.string().min(1).max(256),
  dispatch: workDispatchSchema.optional(),
  claimKeys: z.array(claimKeySchema).max(16),
  status: z.enum(WORK_STATUSES),
  /** The newest status's optional detail — why the job sits in its current
   * state. A newer status without one clears it; it is never accumulated. */
  detail: text.max(1024).optional(),
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
    workTiers: [...WORK_TIERS],
    claimKeyForms: ['repo:<owner/name>', 'path:<owner/name>:<glob>', 'queue:<queue id>', 'pr:<owner/name>#<n>'],
    claimLeaseMs: { min: CLAIM_MIN_LEASE_MS, max: CLAIM_MAX_LEASE_MS },
    claimsGrantExecutionAuthority: false,
  } as const;
}
