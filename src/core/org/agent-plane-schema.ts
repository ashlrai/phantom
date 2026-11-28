/**
 * Org metadata is untrusted planning input, never an execution or send grant.
 * Recovered from ashlrai/phantom PR #5809 (head 57bd29084a9359e13cad8a55db44fa43cb8aa2bd),
 * src/core/org/agent-plane-schema.ts. Schema and validation only. initialPlane (a random,
 * unpersisted board) is deliberately not recovered: the read path refuses absent storage.
 */
import { z } from 'zod';
import { assertMetadata } from '../connectors/profile.js';

export const orgPlaneIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
export const orgPlaneNeedTokenSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}(?![\s\S])/);
export const ORG_PLANE_TIERS = ['LEADER', 'ORCHESTRATOR', 'WORKER_SESSION'] as const;
export const ORG_PLANE_STATUSES = ['active', 'retired'] as const;

const COST_CLASSES = ['local', 'included', 'metered'] as const;
const count = z.number().int().nonnegative().safe();
const need = orgPlaneNeedTokenSchema
  .refine(value => !/(^|[._-])(secrets?|credentials?|payments?|billing|2fa|mfa|auth|passwords?)([._-]|$)/.test(value), 'Restricted capability scope');
const roleSchema = z.object({
  id: orgPlaneIdSchema, title: z.string().trim().min(1).max(120), charter: z.string().trim().min(1).max(2000),
  tier: z.enum(ORG_PLANE_TIERS), reportsTo: orgPlaneIdSchema.nullable(),
  status: z.enum(ORG_PLANE_STATUSES), scope: z.enum(['engineering', 'research', 'janitor', 'comms-draft']),
  needs: z.array(need).max(32),
  laneAffinities: z.array(orgPlaneIdSchema).max(32),
  budget: z.object({ tokens: count.max(1_000_000_000), sessions: count.max(1000), maxCostClass: z.enum(COST_CLASSES) }).strict(),
  sizing: z.object({ batchDepth: count.min(10).max(1000), fanOut: count.max(32) }).strict(),
  sessionId: z.string().regex(/^[a-z][a-z0-9_-]{0,127}(?![\s\S])/).nullable(),
}).strict();
export type OrgAgent = z.infer<typeof roleSchema>;
const proposalSchema = z.object({
  actor: orgPlaneIdSchema, reason: z.string().trim().min(1).max(1000), expectedRevision: count,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('upsert'), role: roleSchema }).strict(),
    z.object({ kind: z.literal('retire'), id: orgPlaneIdSchema }).strict(),
    z.object({ kind: z.literal('revoke'), revision: count.min(1) }).strict(),
  ]),
}).strict();
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
    if (COST_CLASSES.indexOf(role.budget.maxCostClass) > COST_CLASSES.indexOf(parent.budget.maxCostClass)) throw new Error('Child cost class exceeds parent.');
  }
  const sessions = agents.filter(role => role.status === 'active' && role.sessionId !== null).map(role => role.sessionId);
  if (new Set(sessions).size !== sessions.length) throw new Error('Session is already staffed.');
}
