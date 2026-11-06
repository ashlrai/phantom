/**
 * data/agent-roster.ts — the agent workspace's roster (RQ-DESKTOP-P1-2): who
 * the agents are, how each one looks in the sidebar, which team it sits in,
 * and which coding pool it draws on. Pure and read-only: no fetch, no storage,
 * no React. The sidebar (behind the `agentWorkspace` flag) renders the output.
 *
 * SOURCES, in authority order:
 *   1. `fleet.json` (`schema: "fleet.v1"`, written by `phm fleet status
 *      --json`) is the source of truth for WHICH agents exist and what they
 *      have claimed. An agent absent from fleet.v1 is not on the roster.
 *   2. Verse seats (`GET /api/verse/seats`, the same list `phm seats` reads)
 *      supply per-agent detail: a display label, the engine and its default
 *      model, and whether the seat can run right now.
 *   3. Operator preferences (name, avatar, label colour, team, pin, hide,
 *      notify, pool) override presentation only. They never add an agent.
 *
 * REDACTION. fleet.v1 is already allowlisted and scrubbed by the host, but this
 * adapter does not trust that: it copies only the fields below, runs every
 * free-text field through `scrubSecrets`, drops an agent whose id is
 * secret-shaped, and never carries claim ids, leases, account ids, capacity
 * readings or any other field of the snapshot or the seat. Colours and shapes
 * are closed token sets (never raw CSS), so a preference cannot inject style.
 */
import type { VerseEngine, VerseSeat } from '../../core/verse/types.js';
import { scrubSecrets } from '../../core/util/scrub.js';
import { seatRows, type SeatRow } from '../routes/verse/agents/agents-model.js';

export const FLEET_SCHEMA = 'fleet.v1';

// ---------------------------------------------------------------------------
// Pools — fleet.v1's canonical pool ids (docs/router/fleet-v1.md)
// ---------------------------------------------------------------------------

export const ROSTER_POOL_IDS = [
  'codex-cmp',
  'codex-personal',
  'claude-max',
  'devin',
  'grok-ultra-weekly',
  'grok-build',
  'cursor',
  'omlx',
] as const;
export type RosterPoolId = (typeof ROSTER_POOL_IDS)[number];

/** Scheduler aliases fleet.v1 maps onto canonical pools. */
const POOL_ALIASES: Readonly<Record<string, RosterPoolId>> = {
  'codex-primary': 'codex-cmp',
  'codex-secondary': 'codex-personal',
  claude: 'claude-max',
  local: 'omlx',
};

export const POOL_LABELS: Readonly<Record<RosterPoolId, string>> = {
  'codex-cmp': 'Codex (primary)',
  'codex-personal': 'Codex (secondary)',
  'claude-max': 'Claude Max',
  devin: 'Devin',
  'grok-ultra-weekly': 'Grok Ultra',
  'grok-build': 'Grok Build',
  cursor: 'Cursor',
  omlx: 'oMLX (local)',
};

/** The default team an agent lands in, by pool. */
const POOL_TEAMS: Readonly<Record<RosterPoolId, string>> = {
  'codex-cmp': 'Codex',
  'codex-personal': 'Codex',
  'claude-max': 'Claude',
  devin: 'Devin',
  'grok-ultra-weekly': 'Grok',
  'grok-build': 'Grok',
  cursor: 'Cursor',
  omlx: 'Local',
};

const ENGINE_TEAMS: Readonly<Record<VerseEngine, string>> = {
  codex: 'Codex',
  claude: 'Claude',
  devin: 'Devin',
  grok: 'Grok',
  local: 'Local',
};

export const UNASSIGNED_TEAM = 'Unassigned';
export const PINNED_SECTION = 'Pinned';

/** A canonical pool id for a canonical id or scheduler alias; null otherwise. */
export function resolvePool(value: unknown): RosterPoolId | null {
  if (typeof value !== 'string') return null;
  if ((ROSTER_POOL_IDS as readonly string[]).includes(value)) return value as RosterPoolId;
  return Object.hasOwn(POOL_ALIASES, value) ? POOL_ALIASES[value]! : null;
}

// ---------------------------------------------------------------------------
// Presentation tokens — closed sets; the stylesheet maps each to a CSS var
// ---------------------------------------------------------------------------

export const ROSTER_COLORS = ['blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink', 'slate'] as const;
export type RosterColor = (typeof ROSTER_COLORS)[number];

export const AVATAR_SHAPES = ['circle', 'square', 'hexagon', 'diamond'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export interface RosterAvatar {
  color: RosterColor;
  shape: AvatarShape;
  /** One or two letters drawn inside the shape. */
  initials: string;
}

// ---------------------------------------------------------------------------
// Output model
// ---------------------------------------------------------------------------

/** One claimed task, as fleet.v1 reports it. An unclaimed agent has none. */
export interface RosterClaim {
  repo: string | null;
  task: string | null;
  expiresAt: string | null;
}

export interface RosterAgent {
  /** The fleet.v1 agent id (a pool name such as `codex-cmp`, or a Verse `ag_…` id). */
  id: string;
  name: string;
  avatar: RosterAvatar;
  labelColor: RosterColor;
  team: string;
  pinned: boolean;
  hidden: boolean;
  /** Per-agent notifications. On unless the operator turned them off. */
  notify: boolean;
  /** The pool this agent draws on; null leaves the choice to the router. */
  pool: RosterPoolId | null;
  poolLabel: string | null;
  /** Seat detail (from `phm seats`), when a seat matches this agent. */
  seat: Pick<SeatRow, 'seatId' | 'label' | 'engine' | 'modelLabel' | 'disabled'> | null;
  claims: RosterClaim[];
}

export interface RosterPool {
  id: RosterPoolId;
  label: string;
  /** Cursor draws on Grok Ultra; it is never additional capacity. */
  sharedWith: RosterPoolId | null;
}

export interface AgentRoster {
  schema: typeof FLEET_SCHEMA;
  generatedAt: string;
  /** `unknown` when fleet.v1 reported `agents: null` — not the same as no agents. */
  state: 'known' | 'unknown';
  agents: RosterAgent[];
  pools: RosterPool[];
}

// ---------------------------------------------------------------------------
// Preferences — presentation overrides, validated field by field
// ---------------------------------------------------------------------------

export interface AgentPreference {
  name?: string;
  color?: RosterColor;
  shape?: AvatarShape;
  labelColor?: RosterColor;
  team?: string;
  pinned?: boolean;
  hidden?: boolean;
  notify?: boolean;
  /** A pool id, or null to hand the choice back to the router. */
  pool?: RosterPoolId | null;
}

export type RosterPreferences = Readonly<Record<string, AgentPreference>>;

const MAX_AGENTS = 1_000;
const MAX_CLAIMS_PER_AGENT = 50;
const MAX_NAME = 48;
const MAX_TEAM = 32;
const MAX_TEXT = 200;
/** fleet.v1 agent ids: pool names, `ag_…` Verse ids, `local:<tag>` seat ids. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Display text: control characters folded, scrubbed, bounded. Empty → null. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const folded = scrubSecrets(value.replace(/[\u0000-\u001f\u007f]+/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!folded || folded.toLowerCase() === 'unknown') return null;
  return folded.length <= max ? folded : `${folded.slice(0, max - 1)}…`;
}

/** An id is usable only if it is id-shaped AND the scrubber leaves it alone. */
function safeAgentId(value: unknown): string | null {
  if (typeof value !== 'string' || !AGENT_ID.test(value)) return null;
  return scrubSecrets(value) === value ? value : null;
}

function oneOf<T extends string>(set: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (set as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Validate stored preferences. Unknown agents are kept (the agent may come back
 * in the next snapshot); unknown or ill-typed fields are dropped one by one so
 * a single bad value never discards the operator's other choices.
 */
export function parseRosterPreferences(value: unknown): RosterPreferences {
  if (!record(value)) return {};
  const out: Record<string, AgentPreference> = {};
  for (const [id, raw] of Object.entries(value).slice(0, MAX_AGENTS)) {
    if (!safeAgentId(id) || !record(raw)) continue;
    const pref: AgentPreference = {};
    const name = cleanText(raw.name, MAX_NAME);
    if (name) pref.name = name;
    const team = cleanText(raw.team, MAX_TEAM);
    // "Pinned" is the sidebar's own section; a team by that name would merge into it.
    if (team && team.toLowerCase() !== PINNED_SECTION.toLowerCase()) pref.team = team;
    const color = oneOf(ROSTER_COLORS, raw.color);
    if (color) pref.color = color;
    const labelColor = oneOf(ROSTER_COLORS, raw.labelColor);
    if (labelColor) pref.labelColor = labelColor;
    const shape = oneOf(AVATAR_SHAPES, raw.shape);
    if (shape) pref.shape = shape;
    for (const key of ['pinned', 'hidden', 'notify'] as const) if (typeof raw[key] === 'boolean') pref[key] = raw[key];
    if (raw.pool === null) pref.pool = null;
    else if (oneOf(ROSTER_POOL_IDS, raw.pool)) pref.pool = raw.pool as RosterPoolId;
    out[id] = pref;
  }
  return out;
}

// ---------------------------------------------------------------------------
// fleet.v1 projection
// ---------------------------------------------------------------------------

interface FleetRosterSource {
  generatedAt: string;
  agents: Map<string, RosterClaim[]> | null;
  pools: RosterPool[];
}

/**
 * Project a fleet.v1 document onto the fields the roster needs. Throws when the
 * document is not fleet.v1 at all; tolerates (skips) individual bad rows, the
 * same way the host's own reader does.
 */
export function readFleetRoster(value: unknown, now: number): FleetRosterSource {
  if (!record(value) || value.schema !== FLEET_SCHEMA) throw new Error('Not a fleet.v1 snapshot.');
  const generatedAt = isoDate(value.generated_at);
  if (!generatedAt) throw new Error('Not a fleet.v1 snapshot.');

  let agents: Map<string, RosterClaim[]> | null = null;
  if (Array.isArray(value.agents)) {
    agents = new Map();
    for (const row of value.agents.slice(0, MAX_AGENTS)) {
      if (!record(row)) continue;
      const id = safeAgentId(row.agent);
      if (!id) continue;
      const expiresAt = isoDate(row.expires_at);
      const claimed = typeof row.claim_id === 'string';
      // A claim past its expiry is gone, exactly as the host's board treats it.
      if (claimed && (expiresAt === null || Date.parse(expiresAt) <= now)) continue;
      const claims = agents.get(id) ?? [];
      agents.set(id, claims);
      if (!claimed || claims.length >= MAX_CLAIMS_PER_AGENT) continue;
      const repo = typeof row.repo === 'string' && REPO.test(row.repo) ? row.repo : null;
      claims.push({ repo, task: cleanText(row.task, MAX_TEXT), expiresAt });
    }
  }

  const pools: RosterPool[] = [];
  if (Array.isArray(value.pools)) {
    for (const row of value.pools) {
      if (!record(row)) continue;
      const id = oneOf(ROSTER_POOL_IDS, row.id);
      if (!id || pools.some((p) => p.id === id)) continue;
      pools.push({ id, label: POOL_LABELS[id], sharedWith: oneOf(ROSTER_POOL_IDS, row.shared_with) ?? null });
    }
  }
  return { generatedAt, agents, pools };
}

// ---------------------------------------------------------------------------
// Default presentation — deterministic from the id, so an agent keeps its look
// across reloads and machines without anything being stored
// ---------------------------------------------------------------------------

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function initialsOf(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [...words[0]!].slice(0, 2) : [[...words[0]!][0]!, [...words[1]!][0]!];
  return letters.join('').toUpperCase();
}

export function defaultAvatar(id: string, name: string): RosterAvatar {
  const h = hash(id);
  return {
    color: ROSTER_COLORS[h % ROSTER_COLORS.length]!,
    shape: AVATAR_SHAPES[Math.floor(h / ROSTER_COLORS.length) % AVATAR_SHAPES.length]!,
    initials: initialsOf(name),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface BuildRosterInput {
  /** The parsed `fleet.json` document. */
  fleet: unknown;
  /** Verse seats; omitted or empty means no per-agent detail. */
  seats?: readonly VerseSeat[];
  preferences?: unknown;
  now: number;
}

/** The pool a seat draws on: its id when that names a pool; every local (`local:<tag>`) seat runs on oMLX. */
function seatPool(row: SeatRow): RosterPoolId | null {
  return resolvePool(row.seatId) ?? (row.engine === 'local' ? 'omlx' : null);
}

/** The seat that describes an agent: its own id, else the first seat backing its pool. */
function seatFor(id: string, pool: RosterPoolId | null, rows: readonly SeatRow[]): SeatRow | null {
  return rows.find((r) => r.seatId === id) ?? (pool ? rows.find((r) => seatPool(r) === pool) : undefined) ?? null;
}

export function buildAgentRoster(input: BuildRosterInput): AgentRoster {
  const fleet = readFleetRoster(input.fleet, input.now);
  const prefs = parseRosterPreferences(input.preferences);
  const rows = seatRows(input.seats ?? []);

  const agents: RosterAgent[] = [];
  for (const [id, claims] of fleet.agents ?? []) {
    const pref = prefs[id] ?? {};
    const ownPool = resolvePool(id);
    const pool = pref.pool !== undefined ? pref.pool : ownPool;
    const row = seatFor(id, pool, rows);
    const name = pref.name ?? cleanText(row?.seatId === id ? row.label : null, MAX_NAME) ?? (ownPool ? POOL_LABELS[ownPool] : id);
    const base = defaultAvatar(id, name);
    const color = pref.color ?? base.color;
    agents.push({
      id,
      name,
      avatar: { color, shape: pref.shape ?? base.shape, initials: base.initials },
      labelColor: pref.labelColor ?? color,
      team: pref.team ?? (pool ? POOL_TEAMS[pool] : row ? ENGINE_TEAMS[row.engine] : UNASSIGNED_TEAM),
      pinned: pref.pinned ?? false,
      hidden: pref.hidden ?? false,
      notify: pref.notify ?? true,
      pool,
      poolLabel: pool ? POOL_LABELS[pool] : null,
      seat: row
        ? {
            seatId: row.seatId,
            label: cleanText(row.label, MAX_NAME) ?? row.seatId,
            engine: row.engine,
            modelLabel: cleanText(row.modelLabel, MAX_NAME),
            disabled: cleanText(row.disabled, MAX_TEXT),
          }
        : null,
      claims,
    });
  }
  agents.sort(compareAgents);
  return { schema: FLEET_SCHEMA, generatedAt: fleet.generatedAt, state: fleet.agents ? 'known' : 'unknown', agents, pools: fleet.pools };
}

function compareAgents(a: RosterAgent, b: RosterAgent): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Sidebar sections
// ---------------------------------------------------------------------------

export interface RosterSection {
  /** `Pinned`, then each team; the key a collapsed-state store can use. */
  title: string;
  agents: RosterAgent[];
}

/**
 * Pinned agents first (whatever their team), then one section per team in
 * alphabetical order with Unassigned last. Hidden agents are left out unless
 * asked for; an empty section is never returned.
 */
export function rosterSections(agents: readonly RosterAgent[], options: { showHidden?: boolean } = {}): RosterSection[] {
  const visible = agents.filter((a) => options.showHidden || !a.hidden);
  const pinned = visible.filter((a) => a.pinned);
  const byTeam = new Map<string, RosterAgent[]>();
  for (const a of visible) {
    if (a.pinned) continue;
    const list = byTeam.get(a.team) ?? [];
    list.push(a);
    byTeam.set(a.team, list);
  }
  const teams = [...byTeam.keys()].sort((a, b) =>
    a === UNASSIGNED_TEAM ? 1 : b === UNASSIGNED_TEAM ? -1 : a.localeCompare(b));
  const sections: RosterSection[] = pinned.length ? [{ title: PINNED_SECTION, agents: [...pinned].sort(compareAgents) }] : [];
  for (const team of teams) sections.push({ title: team, agents: [...byTeam.get(team)!].sort(compareAgents) });
  return sections;
}
