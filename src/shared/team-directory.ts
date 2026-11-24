import { z } from 'zod';

// eslint-disable-next-line no-control-regex -- names must not inject terminal control bytes
const text = z.string().trim().min(1).regex(/^[^\x00-\x1f\x7f]+$/), name = text.max(100);
const lane = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const seats = z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9:._/-]{0,79}$/)).max(64);
const role = z.enum(['founder', 'engineer', 'viewer']);
const storedId = z.string().regex(/^[a-z0-9][a-z0-9._:/@-]{0,127}$/i);
const share = z.number().min(0).max(100), repos = z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/i)).max(64);
export const TEAM_SCHEMA = 'phantom.team.v1';
export const personInputSchema = z.object({
  displayName: name, role: role.default('engineer'), email: z.email().max(254).optional(),
  slack: z.string().regex(/^[UW][A-Z0-9]{2,31}$/).optional(), phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
  lanes: z.array(lane).max(16).default([]), seats: seats.default([]),
  /** Percent of each resource pool this teammate's agents may use. All shares together stay at 100 or less. */
  poolSharePct: share.optional(), allowedRepos: repos.optional(),
  /** The owner checked these sender ids personally, so messages from them route to this teammate. */
  verified: z.boolean().optional(),
}).strict();
export const personSchema = z.object({
  id: storedId, displayName: name, role,
  identities: z.array(z.object({ kind: z.enum(['email', 'slack', 'phone']), value: text.max(254),
    state: z.enum(['verified', 'pending', 'unknown']).catch('unknown') }).strict()).max(3),
  lanes: z.array(lane).max(16), seats: z.array(storedId), status: z.enum(['pending', 'member']),
  poolSharePct: share.optional(), allowedRepos: repos.optional(), createdAt: z.string().max(40).optional(),
}).strict();
export const directorySchema = z.object({ schema: z.literal(TEAM_SCHEMA), version: z.literal(1), team: z.string(), people: z.array(personSchema),
  orgState: z.enum(['available', 'absent', 'unknown']) }).strict();
export type TeamPerson = z.infer<typeof personSchema>;
export type TeamDirectory = z.infer<typeof directorySchema>;
export type TeamPersonInput = z.input<typeof personInputSchema>;

/** The routing and sharing view of one directory person. Derived, never stored separately. */
export interface TeamMember {
  id: string; display_name: string; role: 'owner' | 'member';
  /** Verified sender ids only; pending or unknown ids are left out. */
  channels: Partial<Record<'email' | 'slack' | 'phone', string[]>>;
  /** Pools (lanes) this teammate brings to the shared pool. */ pools: string[]; seats: string[];
  pool_share_pct: number; allowed_repos: string[]; /** null: unknown (joined before this was recorded). */ created_at: string | null;
}
/** An owner is a founder who has joined; a pending founder record is not an owner yet. */
export const isOwner = (p: TeamPerson): boolean => p.role === 'founder' && p.status === 'member';
export function toMember(p: TeamPerson): TeamMember {
  const channels: TeamMember['channels'] = {};
  for (const i of p.identities) if (i.state === 'verified') (channels[i.kind] ??= []).push(i.value);
  return { id: p.id, display_name: p.displayName, role: isOwner(p) ? 'owner' : 'member', channels,
    pools: p.lanes, seats: p.seats, pool_share_pct: p.poolSharePct ?? 0, allowed_repos: p.allowedRepos ?? [], created_at: p.createdAt ?? null };
}
export const shareTotal = (people: readonly TeamPerson[]): number => people.reduce((sum, p) => sum + (p.poolSharePct ?? 0), 0);

/**
 * Which teammate a message belongs to. Only a sender id verified for that exact channel matches;
 * anything else, including an id two people share, is 'unverified' and must never be acted on.
 */
export function routeMember(message: { channel: string; sender: string }, team: { people: readonly TeamPerson[] }): TeamMember | 'unverified' {
  const sender = typeof message.sender === 'string' ? message.sender.trim().toLowerCase() : '';
  if (!sender) return 'unverified';
  const hits = team.people.filter(p => p.identities.some(i => i.state === 'verified' && i.kind === message.channel && i.value.toLowerCase() === sender));
  return hits.length === 1 ? toMember(hits[0]!) : 'unverified';
}

export interface PoolReading { pool: string; pctUsed: number | null; status?: string; /** Percent of the pool each teammate has used, by id. */ usedByMember?: Record<string, number> }
export interface ShareLeft { pool: string; /** Percent of the whole pool; null when pool usage is unknown. */ left_pct: number | null;
  /** member: own usage counted. pool: own usage unknown, so this is an upper bound. unknown: no fresh pool reading. */ basis: 'member' | 'pool' | 'unknown' }
/** What is left of one teammate's share of each pool, never more than the pool itself has left. */
export function shareLeft(member: Pick<TeamMember, 'id' | 'pool_share_pct'>, pools: readonly PoolReading[]): ShareLeft[] {
  return pools.map(({ pool, pctUsed, status, usedByMember }) => {
    if (pctUsed === null || !Number.isFinite(pctUsed)) return { pool, left_pct: null, basis: 'unknown' as const };
    const used = usedByMember?.[member.id], headroom = status === 'red' ? 0 : 100 - pctUsed;
    const left = Math.max(0, Math.min(member.pool_share_pct - (used ?? 0), headroom));
    return { pool, left_pct: Math.round(left * 100) / 100, basis: used === undefined ? 'pool' as const : 'member' as const };
  });
}
