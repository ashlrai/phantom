/**
 * Declarative org model (org.toml): members, their agents, machines and the share of each lane
 * they contribute. Metadata only: no credential, mail or message content lives here or in the
 * join record, and nothing in this module sends anything or reads provider auth.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { ashlrHome } from '../cloud/store.js';
import { assertMetadata } from '../connectors/profile.js';
import type { ResourceView } from '../fabric/resource-view.js';

export class OrgError extends Error {}
const fail = (message: string): never => { throw new OrgError(message); };

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const lane = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const ROLES = ['leader', 'implementer', 'reviewer', 'researcher'] as const;
const machine = z.object({ id, host: z.string().min(1).max(253).optional() }).strict();
const contribution = z.object({
  lane,
  /** Percent of this member's lane they offer the org. 0 means declared but unavailable. */
  share: z.number().min(0).max(100),
  /** Resource pool whose usage/reset telemetry the leader can read for this lane; absent means unknown usage. */
  pool: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
}).strict();
const agent = z.object({
  id, lane, machine: id,
  roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length),
  /** An agent id or a member id. */
  reports_to: id.optional(),
}).strict();
const member = z.object({
  id, name: z.string().min(1).max(100), nickname: z.string().min(1).max(40).optional(),
  role: z.enum(['founder', 'cofounder', 'member']),
  machines: z.array(machine).max(32).default([]),
  agents: z.array(agent).max(64).default([]),
  contributions: z.array(contribution).max(16).default([]),
}).strict();
const schema = z.object({ version: z.literal(1), leader: id, members: z.array(member).min(1).max(64) }).strict();
export type OrgMember = z.infer<typeof member>;
export type OrgAgent = z.infer<typeof agent>;
export type Org = z.infer<typeof schema>;
export type OrgRole = typeof ROLES[number];

export function orgFile(): string { return join(ashlrHome(), 'org.toml'); }
export function joinsDir(): string { return join(ashlrHome(), 'org', 'joins'); }

export function validateOrg(value: unknown): Org {
  // Inspect before schema errors: diagnostics must never echo rejected values.
  assertMetadata(JSON.stringify(value));
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(`Invalid org.toml: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')).join(', ')}. See docs/AGENT-NETWORK.md#team-org.`);
  const org = parsed.data!;
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
  try { text = readFileSync(file, 'utf8'); } catch { return fail(`No org file at ${file}. Copy docs/examples/org.toml there.`); }
  if (text.length > 256 * 1024) fail('org.toml is too large.');
  let doc: unknown;
  try { doc = parse(text); } catch { return fail('org.toml is not valid TOML.'); }
  return validateOrg(doc);
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
  const m = org.members.find((x) => x.id === req.member) ?? fail(`Unknown member ${req.member}.`);
  const mach = m.machines.find((x) => x.id === req.machine) ?? fail(`${req.machine} is not a declared machine of ${m.id}.`);
  if (mach.host && !sameHost(mach.host, opts.host ?? hostname())) fail(`Run join on ${mach.host}; this is not that machine.`);
  const lanes = req.optIn.map((o) => {
    const c = m.contributions.find((x) => x.lane === o.lane) ?? fail(`${m.id} does not declare lane ${o.lane}.`);
    const share = o.share ?? c.share;
    if (!Number.isFinite(share) || share < 0 || share > c.share) fail(`Share for ${o.lane} must be between 0 and the declared ${c.share}.`);
    return { lane: o.lane, share };
  });
  const record: JoinRecord = { v: 1, member: m.id, machine: mach.id, lanes, joinedAt: (opts.now ?? new Date()).toISOString() };
  const dir = opts.dir ?? joinsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${m.id}.${mach.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return record;
}

export interface QueueJob { id: string; title?: string; priority?: number; lane?: string; costPct?: number }
export function parseQueue(text: string): QueueJob[] {
  assertMetadata(text);
  let v: unknown;
  try { v = JSON.parse(text); } catch { return fail('Queue must be JSON.'); }
  const parsed = z.array(z.object({
    id: z.string().min(1).max(120), title: z.string().max(300).optional(), priority: z.number().min(0).max(1000).optional(),
    lane: lane.optional(), costPct: z.number().positive().max(100).optional(),
  }).strict()).max(2000).safeParse(v);
  if (!parsed.success) fail('Queue entries are {id, title?, priority?, lane?, costPct?}.');
  return parsed.data!;
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
export function planOrg(org: Org, joins: readonly JoinRecord[], view: ResourceView | null, queue: readonly QueueJob[], now = new Date()): OrgPlan {
  const budgets: LaneBudget[] = [], held: OrgPlan['held'] = [];
  for (const m of org.members) for (const c of m.contributions) {
    const joined = joins.filter((j) => j.member === m.id).flatMap((j) => j.lanes).find((l) => l.lane === c.lane);
    if (!joined) { held.push({ member: m.id, lane: c.lane, reason: 'not opted in' }); continue; }
    const share = Math.min(joined.share, c.share);
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
  const remaining = new Map(budgets.map((b) => [`${b.member}/${b.lane}`, b.budgetPct]));
  const roles: OrgPlan['roles'] = [];
  const implementers = new Map<string, string[]>();
  for (const m of org.members) for (const b of budgets.filter((x) => x.member === m.id)) {
    const agents = m.agents.filter((a) => a.lane === b.lane);
    agents.forEach((a, i) => {
      const wantsReview = a.roles.includes('reviewer') && agents.length > 1 && i === agents.length - 1;
      const role: OrgRole = a.roles.includes('leader') && m.id === org.leader ? 'leader' : wantsReview ? 'reviewer' : a.roles.find((r) => r !== 'leader') ?? a.roles[0]!;
      roles.push({ agent: a.id, member: m.id, lane: a.lane, role, reportsTo: a.reports_to ?? null });
      if (role === 'implementer') implementers.set(`${m.id}/${b.lane}`, [...(implementers.get(`${m.id}/${b.lane}`) ?? []), a.id]);
    });
  }
  const assignments: OrgPlan['assignments'] = [], unassigned: OrgPlan['unassigned'] = [];
  const load = new Map<string, number>();
  const cost = (j: QueueJob) => j.costPct ?? DEFAULT_COST_PCT;
  const ordered = [...queue].sort((a, b) => (b.priority ?? 1) / cost(b) - (a.priority ?? 1) / cost(a) || a.id.localeCompare(b.id));
  for (const job of ordered) {
    const fits = budgets.filter((b) => (!job.lane || b.lane === job.lane) && (implementers.get(`${b.member}/${b.lane}`)?.length ?? 0) > 0 &&
      remaining.get(`${b.member}/${b.lane}`)! >= cost(job));
    if (fits.length === 0) { unassigned.push({ job: job.id, reason: job.lane && !budgets.some((b) => b.lane === job.lane) ? `no opted-in contribution on ${job.lane}` : 'no contributed budget left' }); continue; }
    const best = fits.reduce((p, c) => c.urgency * remaining.get(`${c.member}/${c.lane}`)! > p.urgency * remaining.get(`${p.member}/${p.lane}`)! ? c : p);
    const key = `${best.member}/${best.lane}`;
    const agentId = implementers.get(key)!.reduce((p, c) => (load.get(c) ?? 0) < (load.get(p) ?? 0) ? c : p);
    load.set(agentId, (load.get(agentId) ?? 0) + 1);
    remaining.set(key, remaining.get(key)! - cost(job));
    assignments.push({ job: job.id, member: best.member, agent: agentId, lane: best.lane, costPct: cost(job) });
  }
  return { schema: 'org.plan.v1', generatedAt: now.toISOString(), leader: org.leader, budgets, roles, assignments, unassigned, held };
}
