/**
 * routes/verse/fleet-org/org-roster.ts — the Org view's selector. Pure: the
 * leader office (org chart + priorities), the fleet runs snapshot (lanes), the
 * agent-roster.v1 feed (claims) and the Verse seats (models) in; one leader,
 * the executives and the teammates out. No new backend: every input is a feed
 * another pane already reads.
 *
 * Nothing is invented. A reading a source does not carry stays `null` (the
 * view says "not reported") and a source that is down is named in `sources`
 * instead of being rendered as an empty team.
 *
 * Tiers:
 *   leader      the office's `leader` role (a placeholder when the office is down)
 *   executives  every other role in the office's org chart
 *   teammates   one per fleet lane (the lanes the dispatcher runs work on)
 */
import type { VerseSeat } from '../../../../core/verse/types.js';
import { defaultAvatar, type RosterAvatar } from '../../../data/agent-roster.js';
import { seatRows, type SeatRow } from '../agents/agents-model.js';
import type { LeaderOfficePanelView } from '../leader-thread/leader-office-model.js';
import { readLanes } from '../fleet-observe/observe-model.js';

export type OrgTier = 'leader' | 'executive' | 'teammate';
export type OrgStatus = 'working' | 'idle' | 'blocked' | 'held' | 'unknown';
export type OrgSourceState = 'live' | 'unavailable';

export interface OrgMember {
  /** Unique within a roster: `leader`, `exec:<role>` or `lane:<lane>`. */
  id: string;
  tier: OrgTier;
  name: string;
  role: string;
  /** The model behind the member; null when no seat names one. */
  model: string | null;
  /** A router lane (executives, leader) or a fleet lane (teammates). */
  lane: string | null;
  status: OrgStatus;
  /** One short phrase that backs the status, e.g. `2 of 8 slots`. */
  detail: string | null;
  /** Active claims held by this member; null when the roster feed is down. */
  claims: number | null;
  avatar: RosterAvatar & { imageSrc: string | null };
}

export interface OrgRoster {
  leader: OrgMember;
  executives: OrgMember[];
  teammates: OrgMember[];
  sources: { office: OrgSourceState; lanes: OrgSourceState; roster: OrgSourceState; seats: OrgSourceState };
}

export interface OrgRosterInput {
  /** `narrowLeaderOffice` output; null when the office is unavailable. */
  office: LeaderOfficePanelView | null;
  /** GET /api/verse/fleet/runs, unnarrowed; anything else counts as unavailable. */
  runs: unknown;
  /** GET /api/verse/fleet/agent-roster, unnarrowed. */
  roster: unknown;
  /** Verse seats; null when the read failed. */
  seats: readonly VerseSeat[] | null;
}

/** The Phantom mark ships with the app (public/phantom-mark.svg); no vendor logo is bundled. */
export const LEADER_IMAGE = '/phantom-mark.svg';
const OPEN_PRIORITY: ReadonlySet<string> = new Set(['proposed', 'assigned', 'in_progress', 'blocked', 'escalated']);

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

function titleCase(text: string): string {
  return text.split(/[\s_-]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

function avatarFor(id: string, name: string, imageSrc: string | null = null): OrgMember['avatar'] {
  return { ...defaultAvatar(id, name), imageSrc };
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

function engineOf(lane: string): SeatRow['engine'] | null {
  const head = lane.toLowerCase();
  if (head.startsWith('claude')) return 'claude';
  if (head.startsWith('codex')) return 'codex';
  if (head.startsWith('devin')) return 'devin';
  if (head.startsWith('grok')) return 'grok';
  if (head === 'local' || head.startsWith('omlx') || head.startsWith('ollama')) return 'local';
  return null;
}

/** The model a lane runs: its own seat, else the first seat of its engine that can run. */
export function laneModel(lane: string, rows: readonly SeatRow[]): string | null {
  const engine = engineOf(lane);
  const row = rows.find(r => r.seatId === lane && r.modelLabel)
    ?? (engine ? rows.find(r => r.engine === engine && r.modelLabel && !r.disabled) : undefined);
  return row?.modelLabel ?? null;
}

function executive(role: LeaderOfficePanelView['roles'][number], office: LeaderOfficePanelView): OrgMember {
  const mine = office.priorities.filter(p => p.owner === role.owner && OPEN_PRIORITY.has(p.status));
  const blocked = mine.filter(p => p.status === 'blocked' || p.status === 'escalated').length;
  const active = mine.filter(p => p.status === 'assigned' || p.status === 'in_progress').length;
  const proposed = mine.length - blocked - active;
  const status: OrgStatus = blocked ? 'blocked' : active ? 'working' : 'idle';
  const detail = [blocked && `${blocked} blocked`, active && `${active} active`, proposed && `${proposed} proposed`].filter(Boolean).join(', ');
  return {
    id: `exec:${role.id}`, tier: 'executive', name: role.title, role: `Executive · ${titleCase(role.owner)}`,
    model: null, lane: role.lane, status, detail: detail || null, claims: null,
    avatar: avatarFor(`exec:${role.id}`, role.title),
  };
}

export function buildOrgRoster(input: OrgRosterInput): OrgRoster {
  const lanes = readLanes(input.runs);
  const lanesLive = Array.isArray(record(input.runs).lanes);
  const claims = claimsByOwner(input.roster);
  const rows = input.seats ? seatRows(input.seats) : [];

  const teammates: OrgMember[] = lanes.map(l => {
    const status: OrgStatus = l.held ? 'held' : l.running > 0 ? 'working' : 'idle';
    const detail = l.held ? (l.heldReason ?? 'held') : `${l.running} of ${l.target} slots${l.queued ? `, ${l.queued} queued` : ''}`;
    return {
      id: `lane:${l.lane}`, tier: 'teammate' as const, name: titleCase(l.lane), role: 'Worker lane',
      model: laneModel(l.lane, rows), lane: l.lane, status, detail,
      claims: claims ? (claims.get(l.lane) ?? 0) : null,
      avatar: avatarFor(`lane:${l.lane}`, titleCase(l.lane)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const office = input.office;
  const leaderRole = office?.roles.find(r => r.id === 'leader');
  const anyWorking = lanes.some(l => l.running > 0);
  const leaderStatus: OrgStatus = !lanesLive ? 'unknown' : anyWorking ? 'working' : 'idle';
  const total = lanes.reduce((n, l) => n + l.running, 0);
  const leader: OrgMember = {
    id: 'leader', tier: 'leader', name: 'Leader', role: leaderRole?.title ?? 'Digital co-founder',
    model: null, lane: leaderRole?.lane ?? null, status: leaderStatus,
    detail: lanesLive ? `${total} running across ${lanes.length} lane${lanes.length === 1 ? '' : 's'}` : null,
    claims: null, avatar: avatarFor('leader', 'Leader', LEADER_IMAGE),
  };

  const executives = office ? office.roles.filter(r => r.id !== 'leader').map(r => executive(r, office)) : [];
  return {
    leader, executives, teammates,
    sources: {
      office: office ? 'live' : 'unavailable',
      lanes: lanesLive ? 'live' : 'unavailable',
      roster: claims ? 'live' : 'unavailable',
      seats: input.seats ? 'live' : 'unavailable',
    },
  };
}
