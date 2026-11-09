/**
 * Resources coordinated, idle, or duplicated.
 *
 * Reachable means the agent roster (agent-roster.v1) saw the source, or a
 * Phantom worker lane matches it. Idle also needs a fresh sensor headroom
 * above zero and no bus claim. Unknown is never counted as idle.
 */
import type { BusWorkClaimView, BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import type { ResourceRow, ResourceState, UsageWindow } from './types.js';

export interface RosterSessionInput {
  provider: string;
  sessionId: string;
  title: string | null;
  state: string;
  ownership: string | null;
  claims: { id: string }[];
  lastActivity: string | null;
}

export interface RosterSourceInput {
  source: string;
  availability: 'known' | 'unknown';
  sessions: RosterSessionInput[];
}

export const RESOURCE_DEFS = [
  { id: 'devin-cloud', label: 'Devin cloud', probes: ['devin-cloud'], lanes: ['devin'], sensor: 'devin' },
  { id: 'devin-desktop', label: 'Devin desktop', probes: ['devin-desktop'], lanes: ['devin-desktop'], sensor: null },
  { id: 'codex-personal', label: 'Codex personal', probes: ['codex-personal'], lanes: ['codex-personal'], sensor: 'codex-personal' },
  { id: 'dot', label: 'Dot', probes: ['dot'], lanes: ['dot'], sensor: null },
  { id: 'cursor-cloud', label: 'Cursor cloud agents', probes: ['cursor'], lanes: ['cursor'], sensor: null },
  { id: 'claude', label: 'Claude sessions', probes: ['claude'], lanes: ['claude', 'claude-max'], sensor: 'claude-max' },
  { id: 'grok-bot', label: 'Grok Bot teammates', probes: ['grok', 'grok-bot'], lanes: ['grok', 'grok-bot', 'grok-build'], sensor: 'grok-ultra' },
  { id: 'local', label: 'Ollama or oMLX', probes: ['ollama', 'omlx'], lanes: ['omlx', 'local'], sensor: null },
] as const;

function knownSessions(sources: readonly RosterSourceInput[], names: readonly string[]): RosterSessionInput[] {
  return sources.filter((source) => source.availability === 'known' && names.includes(source.source)).flatMap((source) => source.sessions);
}

function qualifying(claim: BusWorkClaimView, nowMs: number, windowMs: number): boolean {
  if (claim.completedAt !== null) return claim.completedAt <= nowMs && nowMs - claim.completedAt <= windowMs;
  if (claim.leaseUntil > nowMs) return true;
  return claim.receivedAt <= nowMs && nowMs - claim.receivedAt <= windowMs && claim.leaseUntil > claim.receivedAt;
}

export function classifyResources(input: {
  roster: readonly RosterSourceInput[] | null;
  claims: BusWorkClaimsInspection | null;
  windows: readonly UsageWindow[];
  nowMs: number;
  windowMs: number;
}): { claims: 'available' | 'missing' | 'unavailable' | 'unknown'; items: ResourceRow[] } {
  const claimsState = input.claims?.source ?? 'unknown';
  const claimsKnown = claimsState === 'available' || claimsState === 'missing';
  const liveClaims = claimsKnown ? (input.claims?.claims ?? []).filter((claim) => qualifying(claim, input.nowMs, input.windowMs)) : [];
  const items = RESOURCE_DEFS.map((def): ResourceRow => {
    if (!input.roster) {
      return { id: def.id, label: def.label, state: 'unknown', reason: 'Agent roster has not been read', headroom: null, sessions: null, claims: null };
    }
    const probeNames = def.probes as readonly string[];
    const laneNames = def.lanes as readonly string[];
    const probes = input.roster.filter((source) => probeNames.includes(source.source));
    const probeKnown = probes.some((source) => source.availability === 'known');
    const phantom = knownSessions(input.roster, ['phantom']).filter((session) => session.ownership !== null && laneNames.includes(session.ownership));
    const own = probeKnown ? knownSessions(input.roster, probeNames) : [];
    const sessions = [...own, ...phantom];
    const reachable = probeKnown || phantom.length > 0;
    if (!reachable) {
      const reason = probes.length === 0
        ? 'No roster probe for this resource'
        : probes.find((source) => source.availability === 'unknown')?.source
          ? `Roster probe ${def.probes.join(' or ')} is unknown`
          : 'Roster probe is unknown';
      return { id: def.id, label: def.label, state: 'unknown', reason, headroom: null, sessions: null, claims: null };
    }
    if (!claimsKnown) {
      return { id: def.id, label: def.label, state: 'unknown', reason: 'Bus claims could not be read', headroom: null, sessions: sessions.length, claims: null };
    }
    const identities = new Set<string>([def.id, ...def.lanes, ...sessions.map((session) => session.sessionId), ...sessions.flatMap((session) => session.ownership ? [session.ownership] : [])]);
    const mine = liveClaims.filter((claim) => identities.has(claim.owner) || identities.has(claim.id) || sessions.some((session) => session.claims.some((ref) => ref.id === claim.id)));
    const sensor = def.sensor === null ? null : input.windows.find((window) => window.lane === def.sensor) ?? null;
    const headroom = sensor && sensor.status === 'fresh' ? sensor.headroom : null;
    const duplicate = duplicated(def.id, sessions, mine, liveClaims, sessionsOf(input.roster));
    let state: ResourceState;
    let reason: string;
    if (duplicate) {
      state = 'duplicated';
      reason = 'Two or more claims or sessions share this task or claim key';
    } else if (mine.length > 0) {
      state = 'coordinated';
      reason = 'Reachable and holding or completing a bus claim in the window';
    } else if (headroom !== null && headroom > 0) {
      state = 'idle';
      reason = 'Reachable, headroom is left, and no bus claim is open';
    } else if (headroom === 0) {
      state = 'no-headroom';
      reason = 'Reachable with no claim, and the sensor headroom is zero';
    } else {
      state = 'unknown';
      reason = 'Reachable, but headroom is unknown, so this is not idle';
    }
    return { id: def.id, label: def.label, state, reason, headroom, sessions: sessions.length, claims: mine.length };
  });
  return { claims: claimsState, items };
}

function sessionsOf(sources: readonly RosterSourceInput[]): RosterSessionInput[] {
  return sources.filter((source) => source.availability === 'known').flatMap((source) => source.sessions);
}

function duplicated(_id: string, sessions: readonly RosterSessionInput[], mine: readonly BusWorkClaimView[], all: readonly BusWorkClaimView[], every: readonly RosterSessionInput[]): boolean {
  const titles = new Map<string, number>();
  for (const session of every) {
    const title = session.title?.trim();
    if (!title) continue;
    titles.set(title, (titles.get(title) ?? 0) + 1);
  }
  if (sessions.some((session) => {
    const title = session.title?.trim();
    return title ? (titles.get(title) ?? 0) >= 2 : false;
  })) return true;
  const byKey = new Map<string, number>();
  for (const claim of all) byKey.set(claim.id, (byKey.get(claim.id) ?? 0) + 1);
  if (mine.some((claim) => (byKey.get(claim.id) ?? 0) >= 2)) return true;
  const holders = new Map<string, Set<string>>();
  for (const session of every) {
    for (const claim of session.claims) {
      const set = holders.get(claim.id) ?? new Set<string>();
      set.add(session.sessionId);
      holders.set(claim.id, set);
    }
  }
  return sessions.some((session) => session.claims.some((claim) => (holders.get(claim.id)?.size ?? 0) >= 2));
}

export function resourceCounts(items: readonly ResourceRow[]): { coordinated: number | null; idle: number | null; duplicated: number | null; unknown: number | null } {
  const reachable = items.some((item) => item.state !== 'unknown');
  const unknown = items.filter((item) => item.state === 'unknown').length;
  if (!reachable) return { coordinated: null, idle: null, duplicated: null, unknown };
  return {
    coordinated: items.filter((item) => item.state === 'coordinated').length,
    idle: items.filter((item) => item.state === 'idle').length,
    duplicated: items.filter((item) => item.state === 'duplicated').length,
    unknown,
  };
}
