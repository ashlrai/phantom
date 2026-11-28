/**
 * Declarative org model (org.toml): members, their agents, machines and the share of each lane
 * they contribute. Metadata only: no credential, mail or message content lives here or in the
 * join record, and nothing in this module sends anything or reads provider auth.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify, TomlError } from 'smol-toml';
import { z } from 'zod';
import { ashlrHome } from '../cloud/store.js';
import { assertMetadata } from '../connectors/profile.js';
import type { ResourceView } from '../fabric/resource-view.js';

export class OrgError extends Error {}
export class OrgNotConfiguredError extends OrgError {}
function fail(message: string): never { throw new OrgError(message); }

export const ORG_FILE_MAX_BYTES = 256 * 1024;
export const orgIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const orgShareSchema = z.number().min(0).max(100);
export const orgJoinRecordSchema = z.object({
  v: z.literal(1),
  member: orgIdSchema,
  machine: orgIdSchema,
  joinedAt: z.string().datetime(),
  lanes: z.array(z.object({ lane: orgIdSchema, share: orgShareSchema })).max(16),
});

const ROLES = ['leader', 'implementer', 'reviewer', 'researcher'] as const;
const machine = z.object({ id: orgIdSchema, host: z.string().min(1).max(253).optional() }).strict();
const contribution = z.object({
  lane: orgIdSchema,
  /** Percent of this member's lane they offer the org. 0 means declared but unavailable. */
  share: orgShareSchema,
  /** Resource pool whose usage/reset telemetry the leader can read for this lane; absent means unknown usage. */
  pool: orgIdSchema.optional(),
}).strict();
const agent = z.object({
  id: orgIdSchema, lane: orgIdSchema, machine: orgIdSchema,
  roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length),
  /** An agent id or a member id. */
  reports_to: orgIdSchema.optional(),
}).strict();
const member = z.object({
  id: orgIdSchema, name: z.string().min(1).max(100), nickname: z.string().min(1).max(40).optional(),
  role: z.enum(['founder', 'cofounder', 'member']),
  machines: z.array(machine).max(32).default([]),
  agents: z.array(agent).max(64).default([]),
  contributions: z.array(contribution).max(16).default([]),
}).strict();
const schema = z.object({ version: z.literal(1), leader: orgIdSchema, members: z.array(member).min(1).max(64) }).strict();
export type Org = z.infer<typeof schema>;
export type OrgRole = typeof ROLES[number];

export function orgFile(): string { return join(ashlrHome(), 'org.toml'); }
export function joinsDir(): string { return join(ashlrHome(), 'org', 'joins'); }
export function joinRecordFilename(memberId: string, machineId: string): string { return `${memberId}.${machineId}.json`; }
export function joinRecordPath(memberId: string, machineId: string, dir = joinsDir()): string {
  return join(dir, joinRecordFilename(memberId, machineId));
}

function writePrivateAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

function memberLaneKey(memberId: string, laneId: string): string {
  return `${memberId}/${laneId}`;
}

/** Render a runnable `phm org join` command for error hints and opt-in guidance. */
export function formatOrgJoinCommand(
  memberId: string,
  machineId: string,
  lanes: readonly (string | { lane: string; share?: number })[] = [],
): string {
  const laneFlags = lanes.map((entry) => {
    if (typeof entry === 'string') return ` --lane ${entry}`;
    return entry.share === undefined ? ` --lane ${entry.lane}` : ` --lane ${entry.lane}=${entry.share}`;
  }).join('');
  return `phm org join --member ${memberId} --machine ${machineId}${laneFlags}`;
}

/**
 * Parse `--lane` tokens (`<lane>` or `<lane>=<share>`) and reject duplicates.
 * When `defaultShare` is given (as in `org init`), bare lanes take that share and
 * explicit shares are checked against `0..100`; otherwise shares stay optional
 * for `joinOrg` to bound against each member's declared share.
 */
export function parseOrgLaneSpecs(args: readonly string[], options: { defaultShare: number }): { lane: string; share: number }[];
export function parseOrgLaneSpecs(args: readonly string[], options?: { defaultShare?: undefined }): { lane: string; share?: number }[];
export function parseOrgLaneSpecs(
  args: readonly string[],
  options: { defaultShare?: number } = {},
): { lane: string; share?: number }[] {
  const specs = args.map((s) => {
    const eq = s.indexOf('=');
    if (eq >= 0 && s.indexOf('=', eq + 1) >= 0) fail(`--lane takes <lane> or <lane>=<share>: '${s}'`);
    const laneName = eq < 0 ? s : s.slice(0, eq);
    const shareText = eq < 0 ? undefined : s.slice(eq + 1);
    if (laneName === '') fail(`--lane needs a lane name: '${s}'`);
    if (shareText === undefined) {
      return options.defaultShare === undefined ? { lane: laneName, share: undefined } : { lane: laneName, share: options.defaultShare };
    }
    const share = Number(shareText);
    const badNumber = shareText.trim() === '' || !Number.isFinite(share);
    if (options.defaultShare !== undefined) {
      if (badNumber || share < 0 || share > 100) fail(`--lane share must be a number from 0 to 100: '${s}'`);
    } else if (badNumber) {
      fail(`--lane share must be a number: '${s}'`);
    }
    return { lane: laneName, share };
  });
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.lane)) fail(`--lane ${spec.lane} was given more than once.`);
    seen.add(spec.lane);
  }
  return specs;
}

/** Parse `--agent <id>:<lane>` tokens and reject duplicate agent ids. */
export function parseOrgAgentSpecs(args: readonly string[]): { id: string; lane: string }[] {
  const agents = args.map((s) => {
    const parts = s.split(':');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') fail(`--agent takes <id>:<lane>: '${s}'`);
    return { id: parts[0]!, lane: parts[1]! };
  });
  const seen = new Set<string>();
  for (const a of agents) {
    if (seen.has(a.id)) fail(`--agent ${a.id} was given more than once.`);
    seen.add(a.id);
  }
  return agents;
}

export function validateOrg(value: unknown): Org {
  // Inspect before schema errors: diagnostics must never echo rejected values.
  assertMetadata(JSON.stringify(value));
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(`Invalid org.toml: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')).join(', ')}. See docs/AGENT-NETWORK.md#team-org.`);
  const org = parsed.data;
  const members = new Set<string>(), agents = new Map<string, string>();
  for (const m of org.members) {
    if (members.has(m.id)) fail(`Duplicate member ${m.id}.`);
    members.add(m.id);
    const machines = new Set(m.machines.map((x) => x.id)), lanes = new Set<string>();
    if (machines.size !== m.machines.length) fail(`Duplicate machine for ${m.id}.`);
    for (const c of m.contributions) { if (lanes.has(c.lane)) fail(`Duplicate lane ${c.lane} for ${m.id}.`); lanes.add(c.lane); }
    for (const a of m.agents) {
      if (agents.has(a.id) || members.has(a.id)) fail(`Duplicate id ${a.id}.`);
      agents.set(a.id, m.id);
      if (!machines.has(a.machine)) fail(`Agent ${a.id} uses an undeclared machine of ${m.id}.`);
      if (!lanes.has(a.lane)) fail(`Agent ${a.id} lane ${a.lane} is not a contribution of ${m.id}.`);
    }
  }
  if (!members.has(org.leader)) fail(`Leader ${org.leader} is not a member.`);
  const reportsTo = new Map<string, string>();
  for (const m of org.members) for (const a of m.agents) if (a.reports_to) {
    if (!agents.has(a.reports_to) && !members.has(a.reports_to)) fail(`Agent ${a.id} reports to unknown ${a.reports_to}.`);
    reportsTo.set(a.id, a.reports_to);
  }
  for (const start of reportsTo.keys()) {
    const seen = new Set<string>();
    for (let at: string | undefined = start; at !== undefined; at = reportsTo.get(at)) {
      if (seen.has(at)) fail(`Reporting cycle through ${at}.`);
      seen.add(at);
    }
  }
  return org;
}

export function loadOrg(file = orgFile()): Org {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      let missing: boolean;
      try { missing = !lstatSync(file, { throwIfNoEntry: false }); } catch { fail('Could not read org.toml.'); }
      if (missing) throw new OrgNotConfiguredError(`No org file at ${file}. org.toml holds org ids and lane shares only, never credentials: get a copy from your org leader, or start a new org with phm org init --member <id> --machine <id>.`);
    }
    fail('Could not read org.toml.');
  }
  if (Buffer.byteLength(text) > ORG_FILE_MAX_BYTES) fail('org.toml is too large.');
  let doc: unknown;
  try { doc = parse(text); } catch (err) {
    // TomlError carries the 1-based position of the first bad token; naming it
    // gives a member something concrete to send their leader. File content is
    // never echoed — org.toml holds member and machine ids only.
    const at = err instanceof TomlError ? ` at line ${err.line}` : '';
    fail(`org.toml is not valid TOML${at}. org.toml is maintained by your org leader — ask them to repair it and send a fresh copy.`);
  }
  return validateOrg(doc);
}

const INIT_HEADER = '# org.toml — declarative org model: member and machine ids, lane shares; never credentials or auth.\n'
  + '# Created by `phm org init`. Edit members, agents and contributions freely; each machine opts\n'
  + '# into lanes with `phm org join --member <id> --machine <id> --lane <lane>[=<share>] --json`.\n'
  + '# Format guide: docs/AGENT-NETWORK.md#team-org\n\n';

/**
 * `phm org init`: write a starter org.toml declaring `member` as leader (founder) of a new org
 * on one machine, with the given lane contributions. `agents` declares implementer agents on
 * that machine, one lane each, reporting to the founder — without them `phm org plan` can never
 * assign work (every job reads "no implementer agent declared"). The document is validated
 * before anything is written, and an existing file is never overwritten.
 */
export function initOrg(req: { member: string; machine: string; name?: string; lanes: { lane: string; share: number }[];
  agents?: { id: string; lane: string }[] },
  file = orgFile()): { file: string; org: Org } {
  // Empty arrays stay out of the file: the schema defaults fill them on read.
  const doc = {
    version: 1 as const,
    leader: req.member,
    members: [{
      id: req.member, name: req.name ?? req.member, role: 'founder' as const,
      machines: [{ id: req.machine }],
      ...(req.lanes.length ? { contributions: req.lanes.map((l) => ({ lane: l.lane, share: l.share })) } : {}),
      ...(req.agents?.length ? { agents: req.agents.map((a) => ({ id: a.id, lane: a.lane, machine: req.machine,
        roles: ['implementer' as const], reports_to: req.member })) } : {}),
    }],
  };
  const org = validateOrg(doc);
  if (existsSync(file)) fail(`org.toml already exists at ${file}. Edit it or remove it first.`);
  writePrivateAtomic(file, INIT_HEADER + stringify(doc));
  return { file, org };
}

/** One member's opt-in on one machine. Never contains credentials; usage and auth stay on that machine. */
export interface JoinRecord { v: 1; member: string; machine: string; lanes: { lane: string; share: number }[]; joinedAt: string }

export function readJoins(dir = joinsDir()): JoinRecord[] {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out: JoinRecord[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, n), 'utf8')) as JoinRecord;
      if (r.v === 1 && typeof r.member === 'string' && Array.isArray(r.lanes)) out.push(r);
    } catch { /* a malformed record opts nothing in */ }
  }
  return out;
}

const sameHost = (a: string, b: string) => a.toLowerCase().replace(/\.local$/, '') === b.toLowerCase().replace(/\.local$/, '');

/**
 * Run by a member on their own machine. Contribution is opt-in per lane: a lane not named in
 * `optIn` stays at zero. A share can only be lowered from the declared value, never raised.
 */
export function joinOrg(org: Org, req: { member: string; machine: string; optIn: { lane: string; share?: number }[] },
  opts: { dir?: string; host?: string; now?: Date } = {}): JoinRecord {
  // Identity refusals name the declared ids and who fixes a missing one: a first
  // join on a new machine hits exactly these errors, and "not declared" alone
  // cannot tell a typo from an entry the leader has not added to org.toml yet.
  const memberIds = org.members.map((x) => x.id);
  const m = org.members.find((x) => x.id === req.member)
    ?? fail(`Unknown member ${req.member}. This org.toml declares: ${memberIds.join(', ')}. If yours is missing, ask the leader to add it to org.toml before join.`);
  const machineIds = m.machines.map((x) => x.id);
  const mach = m.machines.find((x) => x.id === req.machine)
    ?? fail(`${req.machine} is not a declared machine of ${m.id}. Declared machines: ${machineIds.length ? machineIds.join(', ') : 'none'}. Pick a declared id, or ask the leader to add this machine to org.toml.`);
  const here = opts.host ?? hostname();
  if (mach.host && !sameHost(mach.host, here)) {
    // The declared host pins the machine to one computer. Name the way
    // through like the other identity refusals do: when exactly one sibling
    // machine's host is this computer that is almost always the id the member
    // meant; otherwise the host likely changed or the computer was replaced,
    // and only the leader can re-point it in org.toml.
    const matches = m.machines.filter((x) => x.id !== mach.id && x.host !== undefined && sameHost(x.host, here));
    const way = matches.length === 1
      ? ` This computer matches declared machine ${matches[0]!.id}: run ${formatOrgJoinCommand(m.id, matches[0]!.id)}.`
      : ' If this computer replaced it or was renamed, ask the leader to update the machine\'s host in org.toml.';
    fail(`Run join on ${mach.host}; this is not that machine.${way}`);
  }
  const laneIds = m.contributions.map((x) => x.lane);
  const lanes = req.optIn.map((o) => {
    const c = m.contributions.find((x) => x.lane === o.lane)
      ?? fail(`${m.id} does not declare lane ${o.lane}. Declared lanes: ${laneIds.length ? laneIds.join(', ') : 'none'}. Pick a declared lane, or ask the leader to add the contribution in org.toml.`);
    const share = o.share ?? c.share;
    if (!Number.isFinite(share) || share < 0 || share > c.share) fail(`Share for ${o.lane} must be between 0 and the declared ${c.share}.`);
    return { lane: o.lane, share };
  });
  const record: JoinRecord = { v: 1, member: m.id, machine: mach.id, lanes, joinedAt: (opts.now ?? new Date()).toISOString() };
  writePrivateAtomic(joinRecordPath(m.id, mach.id, opts.dir ?? joinsDir()), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/**
 * Lanes a re-join dropped: opted in on the machine's previous record, absent from the new one.
 * Join replaces the whole record, so a lane not named again stops being contributed; callers
 * surface these so the opt-out is never silent.
 */
export function droppedJoinLanes(previous: JoinRecord | undefined, next: JoinRecord): { lane: string; share: number }[] {
  if (!previous) return [];
  const kept = new Set(next.lanes.map((l) => l.lane));
  return previous.lanes.filter((l) => !kept.has(l.lane));
}

/**
 * Declared contributions this machine's join record has not opted into, each with the
 * declared share a bare `--lane <name>` re-join would grant. Read-only projection for the
 * join reply: it names what a re-join could still add — including the zero-lane first run,
 * which contributes nothing until one is named — never what it must contribute.
 */
export function openJoinLanes(org: Org, record: JoinRecord): { lane: string; share: number }[] {
  const member = org.members.find((x) => x.id === record.member);
  if (!member) return [];
  const opted = new Set(record.lanes.map((l) => l.lane));
  return member.contributions.filter((c) => !opted.has(c.lane)).map((c) => ({ lane: c.lane, share: c.share }));
}

export interface QueueJob { id: string; title?: string; priority?: number; lane?: string; costPct?: number }
export function parseQueue(text: string): QueueJob[] {
  assertMetadata(text);
  let v: unknown;
  try { v = JSON.parse(text); } catch { fail('Queue must be JSON.'); }
  const parsed = z.array(z.object({
    id: z.string().min(1).max(120), title: z.string().max(300).optional(), priority: z.number().min(0).max(1000).optional(),
    lane: orgIdSchema.optional(), costPct: z.number().positive().max(100).optional(),
  }).strict()).max(2000).safeParse(v);
  if (!parsed.success) fail('Queue entries are {id, title?, priority?, lane?, costPct?}.');
  return parsed.data;
}

const POOL_OF: Record<string, string> = { claude: 'claude-max' };
const UNKNOWN_HEADROOM_PCT = 25;
const DEFAULT_COST_PCT = 2;

export interface LaneBudget {
  member: string; lane: string; pool: string | null; share: number; headroomPct: number | null;
  hoursToReset: number | null; urgency: number; budgetPct: number; usage: 'known' | 'unknown';
}
export interface OrgPlan {
  schema: 'org.plan.v1'; generatedAt: string; leader: string; budgets: LaneBudget[];
  roles: { agent: string; member: string; lane: string; role: OrgRole; reportsTo: string | null }[];
  assignments: { job: string; member: string; agent: string; lane: string; costPct: number }[];
  unassigned: { job: string; reason: string }[]; held: { member: string; lane: string; reason: string }[];
}

/**
 * Merged output per unit of pooled usage: jobs are ordered by priority per cost, each goes to the
 * opted-in lane with the most urgent (soonest reset) remaining budget, and no member's contributed
 * budget is exceeded. Lanes with unknown usage get a conservative fixed headroom; a red pool gets none.
 */
export function planOrg(org: Org, joins: readonly JoinRecord[], view: ResourceView | null, queue: readonly QueueJob[], now = new Date(),
  capacity?: readonly { lane: string; additional_slots: number | null }[]): OrgPlan {
  const budgets: LaneBudget[] = [], held: OrgPlan['held'] = [];
  for (const m of org.members) for (const c of m.contributions) {
    // A member's machines each hold their own join record for the lane, and
    // every offer draws on the one declared pool for this member+lane — the
    // offers are not additive. The member's ceiling is the largest share any
    // machine committed; taking the first record would make the plan depend
    // on join-filename order and could starve a lane the member fully offered.
    const offers = joins.filter((j) => j.member === m.id).flatMap((j) => j.lanes).filter((l) => l.lane === c.lane);
    if (!offers.length) { held.push({ member: m.id, lane: c.lane, reason: 'not opted in' }); continue; }
    const share = Math.min(Math.max(...offers.map((o) => o.share)), c.share);
    if (share <= 0) { held.push({ member: m.id, lane: c.lane, reason: 'zero share' }); continue; }
    const pool = c.pool ?? POOL_OF[c.lane] ?? null;
    const reading = view && pool ? view.pools.find((p) => p.pool === pool) : undefined;
    // pctUsed is only set for a fresh, validated reading; status can stay unknown until a burn rate exists.
    const known = reading !== undefined && reading.pctUsed !== null;
    const headroomPct = known ? (reading.status === 'red' ? 0 : 100 - reading.pctUsed!) : null;
    const hours = known && reading.resetAt ? Math.max(0, (Date.parse(reading.resetAt) - now.getTime()) / 3_600_000) : null;
    budgets.push({
      member: m.id, lane: c.lane, pool, share, headroomPct, hoursToReset: hours === null ? null : Math.round(hours * 10) / 10,
      // Use-it-or-lose-it: headroom that resets soon is worth spending first.
      urgency: hours === null ? 1 : Math.round((1 + 12 / (12 + hours)) * 1000) / 1000,
      budgetPct: Math.round((headroomPct ?? UNKNOWN_HEADROOM_PCT) * share) / 100, usage: known ? 'known' : 'unknown',
    });
  }
  const remaining = new Map(budgets.map((b) => [memberLaneKey(b.member, b.lane), b.budgetPct]));
  const roles: OrgPlan['roles'] = [];
  const implementers = new Map<string, string[]>();
  for (const m of org.members) for (const b of budgets.filter((x) => x.member === m.id)) {
    const key = memberLaneKey(m.id, b.lane);
    const agents = m.agents.filter((a) => a.lane === b.lane);
    agents.forEach((a, i) => {
      const wantsReview = a.roles.includes('reviewer') && agents.length > 1 && i === agents.length - 1;
      const role: OrgRole = a.roles.includes('leader') && m.id === org.leader ? 'leader' : wantsReview ? 'reviewer' : a.roles.find((r) => r !== 'leader') ?? a.roles[0]!;
      roles.push({ agent: a.id, member: m.id, lane: a.lane, role, reportsTo: a.reports_to ?? null });
      if (role === 'implementer') {
        const list = implementers.get(key);
        if (list) list.push(a.id);
        else implementers.set(key, [a.id]);
      }
    });
  }
  const assignments: OrgPlan['assignments'] = [], unassigned: OrgPlan['unassigned'] = [];
  const load = new Map<string, number>();
  const slots = new Map(capacity?.map(row => [row.lane, row.additional_slots]));
  const cost = (j: QueueJob) => j.costPct ?? DEFAULT_COST_PCT;
  const staffed = (b: LaneBudget) => (implementers.get(memberLaneKey(b.member, b.lane))?.length ?? 0) > 0;
  const ordered = [...queue].sort((a, b) => (b.priority ?? 1) / cost(b) - (a.priority ?? 1) / cost(a) || a.id.localeCompare(b.id));
  for (const job of ordered) {
    const covers = (b: LaneBudget) => !job.lane || b.lane === job.lane;
    const funded = budgets.filter((b) => covers(b) && staffed(b) && remaining.get(memberLaneKey(b.member, b.lane))! >= cost(job));
    const fits = funded.filter(b => slots.get(b.lane) !== 0);
    if (fits.length === 0) {
      // The reason names the real blocker: a pinned lane nobody opted into,
      // opted-in lanes with no declared implementer (`phm org init` writes
      // none), or staffed lanes whose contributed budget is already spent.
      const covering = budgets.filter(covers);
      unassigned.push({ job: job.id, reason: funded.length ? 'no resource-plan slots left' : covering.length === 0
        ? (job.lane ? `no opted-in contribution on ${job.lane}` : 'no contributed budget left')
        : covering.every((b) => !staffed(b))
          ? `no implementer agent declared on ${[...new Set(covering.map((b) => memberLaneKey(b.member, b.lane)))].join(', ')}`
          : 'no contributed budget left' });
      continue;
    }
    const best = fits.reduce((p, c) => c.urgency * remaining.get(memberLaneKey(c.member, c.lane))! > p.urgency * remaining.get(memberLaneKey(p.member, p.lane))! ? c : p);
    const key = memberLaneKey(best.member, best.lane);
    const spare = slots.get(best.lane);
    if (spare != null) slots.set(best.lane, spare - 1);
    const agentId = implementers.get(key)!.reduce((p, c) => (load.get(c) ?? 0) < (load.get(p) ?? 0) ? c : p);
    load.set(agentId, (load.get(agentId) ?? 0) + 1);
    remaining.set(key, remaining.get(key)! - cost(job));
    assignments.push({ job: job.id, member: best.member, agent: agentId, lane: best.lane, costPct: cost(job) });
  }
  return { schema: 'org.plan.v1', generatedAt: now.toISOString(), leader: org.leader, budgets, roles, assignments, unassigned, held };
}
