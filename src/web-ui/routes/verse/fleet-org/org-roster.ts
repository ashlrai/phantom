/**
 * routes/verse/fleet-org/org-roster.ts — the Org view's executives. Pure: the
 * leader office (org chart + priorities) in, one card per executive role out.
 * The leader, lanes and jobs are not built here: they come from the
 * `fleet.org.v1` tree (`phm org`), drawn by OrgTree.tsx.
 */
import { defaultAvatar, type RosterAvatar } from '../../../data/agent-roster.js';
import type { LeaderOfficePanelView } from '../leader-thread/leader-office-model.js';

export type OrgStatus = 'working' | 'idle' | 'blocked';

export interface OrgMember {
  /** `exec:<role>`, unique within the office. */
  id: string;
  name: string;
  role: string;
  /** The router lane the role works through. */
  lane: string | null;
  status: OrgStatus;
  /** One short phrase that backs the status, e.g. `1 active, 1 proposed`. */
  detail: string | null;
  avatar: RosterAvatar & { imageSrc: string | null };
}

const OPEN_PRIORITY: ReadonlySet<string> = new Set(['proposed', 'assigned', 'in_progress', 'blocked', 'escalated']);

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

function titleCase(text: string): string {
  return text.split(/[\s_-]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

/** Claim counts per owner from agent-roster.v1; null when the feed is not that schema. */
export function claimsByOwner(roster: unknown): Map<string, number> | null {
  const data = record(roster);
  const claims = record(data.claims);
  if (data.schema !== 'agent-roster.v1' || !Array.isArray(claims.items)) return null;
  const counts = new Map<string, number>();
  for (const raw of claims.items) {
    const item = record(raw);
    if (typeof item.owner !== 'string' || item.completed === true) continue;
    counts.set(item.owner, (counts.get(item.owner) ?? 0) + 1);
  }
  return counts;
}

function executive(role: LeaderOfficePanelView['roles'][number], office: LeaderOfficePanelView): OrgMember {
  const mine = office.priorities.filter(p => p.owner === role.owner && OPEN_PRIORITY.has(p.status));
  const blocked = mine.filter(p => p.status === 'blocked' || p.status === 'escalated').length;
  const active = mine.filter(p => p.status === 'assigned' || p.status === 'in_progress').length;
  const proposed = mine.length - blocked - active;
  const status: OrgStatus = blocked ? 'blocked' : active ? 'working' : 'idle';
  const detail = [blocked && `${blocked} blocked`, active && `${active} active`, proposed && `${proposed} proposed`].filter(Boolean).join(', ');
  return {
    id: `exec:${role.id}`, name: role.title, role: `Executive · ${titleCase(role.owner)}`,
    lane: role.lane, status, detail: detail || null,
    avatar: { ...defaultAvatar(`exec:${role.id}`, role.title), imageSrc: null },
  };
}

/** Every role in the office's org chart except the leader; null when the office is unavailable. */
export function orgExecutives(office: LeaderOfficePanelView | null): OrgMember[] | null {
  return office ? office.roles.filter(r => r.id !== 'leader').map(r => executive(r, office)) : null;
}
