/** Org metadata is untrusted planning input, never an execution or send grant. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assertMetadata } from '../connectors/profile.js';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
const count = z.number().int().nonnegative().safe();
const need = z.string().regex(/^[a-z][a-z0-9._-]{0,63}(?![\s\S])/)
  .refine(value => !/(^|[._-])(secrets?|credentials?|payments?|billing|2fa|mfa|auth|passwords?)([._-]|$)/.test(value), 'Restricted capability scope');
export const roleSchema = z.object({
  id, title: z.string().trim().min(1).max(120), charter: z.string().trim().min(1).max(2000),
  tier: z.enum(['LEADER', 'ORCHESTRATOR', 'WORKER_SESSION']), reportsTo: id.nullable(),
  status: z.enum(['active', 'retired']), scope: z.enum(['engineering', 'research', 'janitor', 'comms-draft']),
  needs: z.array(need).max(32),
  laneAffinities: z.array(id).max(32),
  budget: z.object({ tokens: count.max(1_000_000_000), sessions: count.max(1000), maxCostClass: z.enum(['local', 'included', 'metered']) }).strict(),
  sizing: z.object({ batchDepth: count.min(10).max(1000), fanOut: count.max(32) }).strict(),
  sessionId: z.string().regex(/^[a-z][a-z0-9_-]{0,127}(?![\s\S])/).nullable(),
}).strict();
export type OrgAgent = z.infer<typeof roleSchema>;
export const proposalSchema = z.object({
  actor: id, reason: z.string().trim().min(1).max(1000), expectedRevision: count,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('upsert'), role: roleSchema }).strict(),
    z.object({ kind: z.literal('retire'), id }).strict(),
    z.object({ kind: z.literal('revoke'), revision: count.min(1) }).strict(),
  ]),
}).strict();
export type OrgProposal = z.infer<typeof proposalSchema>;
const editSchema = z.object({ before: roleSchema.nullable(), after: roleSchema.nullable() }).strict();
export const planeSchema = z.object({
  schema: z.literal('org.agents.v1'), storeId: z.string().uuid(), revision: count,
  agents: z.array(roleSchema).max(256),
  ledger: z.array(z.object({
    revision: count.min(1), at: z.string().datetime(), proposal: proposalSchema,
    applied: z.boolean(), edits: z.array(editSchema).max(256), busDelivered: z.boolean(),
  }).strict()).max(2000),
}).strict();
export type OrgPlane = z.infer<typeof planeSchema>;

export function metadata<T>(schema: z.ZodType<T>, raw: unknown): T {
  assertMetadata(JSON.stringify(raw) ?? '');
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error('Invalid org metadata; check the documented schema.');
  return result.data;
}

export function validateChart(agents: OrgAgent[]): void {
  const roles = new Map(agents.map(role => [role.id, role]));
  if (roles.size !== agents.length || roles.has('board')) throw new Error('Duplicate or reserved role id.');
  const leaders = agents.filter(role => role.tier === 'LEADER');
  if (leaders.length !== 1 || leaders[0]!.id !== 'leader' || leaders[0]!.status !== 'active' || leaders[0]!.reportsTo !== null) throw new Error('One active leader is required.');
  for (const role of agents) {
    if (role.sessionId !== null && role.tier !== 'WORKER_SESSION') throw new Error('Only workers bind sessions.');
    if (role.tier === 'LEADER' || role.status === 'retired') continue;
    const parent = roles.get(role.reportsTo ?? '');
    if (!parent || parent.status !== 'active' || parent.tier !== (role.tier === 'ORCHESTRATOR' ? 'LEADER' : 'ORCHESTRATOR')) throw new Error('Invalid reporting tier or inactive parent.');
    const siblings = agents.filter(other => other.status === 'active' && other.reportsTo === parent.id);
    if (siblings.reduce((sum, child) => sum + child.budget.tokens, 0) > parent.budget.tokens || siblings.reduce((sum, child) => sum + child.budget.sessions, 0) > parent.budget.sessions) throw new Error('Child budgets exceed parent planning ceiling.');
    if (['local', 'included', 'metered'].indexOf(role.budget.maxCostClass) > ['local', 'included', 'metered'].indexOf(parent.budget.maxCostClass)) throw new Error('Child cost class exceeds parent.');
  }
  const sessions = agents.filter(role => role.status === 'active' && role.sessionId !== null).map(role => role.sessionId);
  if (new Set(sessions).size !== sessions.length) throw new Error('Session is already staffed.');
}

export function initialPlane(): OrgPlane {
  const role = (id: string, title: string, charter: string, scope: OrgAgent['scope']): OrgAgent => ({
    id, title, charter, scope, tier: id === 'leader' ? 'LEADER' : 'ORCHESTRATOR', reportsTo: id === 'leader' ? null : 'leader',
    status: 'active', needs: scope === 'comms-draft' ? [] : ['git', 'gh', 'node'], laneAffinities: [],
    budget: { tokens: 0, sessions: 0, maxCostClass: 'included' }, sizing: { batchDepth: 100, fanOut: 0 }, sessionId: null,
  });
  return { schema: 'org.agents.v1', storeId: randomUUID(), revision: 0, ledger: [], agents: [
    role('leader', 'CEO / digital cofounder', 'Board-facing strategy; staff and re-scope the org from vitals and findings.', 'research'),
    role('engineering', 'Engineering orchestrator', 'Grokbot-style engineering; batch work, spawn bounded sub-agents, generate next work.', 'engineering'),
    role('janitor', 'JANITOR orchestrator', 'Continuously find dead code and stale information across repos; propose a kill list and next work ranked by leverage to the unified vision.', 'janitor'),
    role('comms', 'Comms orchestrator', 'Draft email, LinkedIn, iMessage and dot channel work through existing send gates.', 'comms-draft'),
  ] };
}
