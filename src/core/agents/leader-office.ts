/**
 * One leader office: the digital co-founder Mason talks to.
 *
 * Every decision reads the world model and the shared-visibility brief
 * (`phm context`). Work is claimed with `acquireWorkClaim` (`phm claim`) and
 * routed on the durable bus to a role in the declarative org chart. The
 * existing router admits the role's lane. This module does not call a model
 * and does not spend. Channel adapters are not here: they call
 * `acceptOwnerMessage` and drain `readLeaderOutbox`.
 *
 * KILL stops every mutation. It is read at entry and again immediately before
 * the office file is written and before each bus post. With no standing grant,
 * ordinary work is recorded as a proposal and is not put on the bus.
 *
 * A request is routed only when its words are ordinary work and a role keyword
 * or an explicit owner picks the lane. The hard-limit regex only labels a
 * match for the owner. It does not decide escalation. Anything else escalates.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentStandingPolicy } from '../authority/effective-config.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import { readWorldModel } from '../world/read.js';
import type { WorldModel } from '../world/types.js';
import { listCoordination } from './claim-store.js';
import {
  acquireWorkClaim,
  buildContextBrief,
  releaseWorkClaim,
  type OpenWorkPull,
  type WorkHolder,
} from './work-visibility.js';

export const LEADER_OFFICE_SCHEMA = 'phantom.leader-office/v1' as const;
export const LEADER_ORG_SCHEMA = 'phantom.leader-org/v1' as const;
const ROUTER_LANES = ['frontier', 'work', 'mid', 'fast'] as const;
export type RouterLane = typeof ROUTER_LANES[number];
const ASSIGNMENT_STATUSES = ['proposed', 'assigned', 'in_progress', 'blocked', 'done', 'escalated'] as const;
export type AssignmentStatus = typeof ASSIGNMENT_STATUSES[number];
export const ESCALATION_CATEGORIES = ['secrets', 'money', 'outside-send', 'owner-data-destruction', 'unsure'] as const;
export type EscalationCategory = typeof ESCALATION_CATEGORIES[number];
const RQ = /^RQ-[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const DUE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 4_000;
const SUMMARY_MAX = 500;
const BUS_TTL_MS = 86_400_000;
const STORE_CAP = 200;

export interface LeaderRole {
  id: string;
  title: string;
  owner: string;
  lane: RouterLane;
  mission: string;
  routes: string[];
}

export interface LeaderPeer {
  rq: string;
  surface: string;
  note: string;
}

export interface LeaderOrg {
  schema: typeof LEADER_ORG_SCHEMA;
  coordinatesWith: LeaderPeer[];
  roles: LeaderRole[];
}

export interface LeaderAssignment {
  rq: string;
  owner: string;
  lane: RouterLane;
  due: string | null;
  status: AssignmentStatus;
  outcome: string | null;
  summary: string;
  updatedAt: string;
}

export interface LeaderOfficeMessage {
  id: string;
  at: string;
  direction: 'in' | 'out';
  text: string;
  to: string;
  rq: string | null;
  decision: string;
}

export interface LeaderWorldView {
  schema: string | null;
  generatedAt: string | null;
  blindSpotCount: number | null;
  unavailable: boolean;
  reason: string | null;
}

export interface LeaderContextView {
  schema: string;
  lane: string;
  bytes: number;
  truncated: boolean;
  blindSpots: number;
  working: number;
}

export interface LeaderEscalation {
  category: EscalationCategory;
  reason: string;
}

export interface LeaderRoute {
  via: 'existing-router';
  tier: RouterLane;
  roleId: string;
  busTo: string;
  spend: 'none';
}

export type LeaderDecisionStatus = 'routed' | 'proposed' | 'escalated' | 'blocked' | 'stopped' | 'refused' | 'unavailable';

export interface LeaderDecision {
  schema: typeof LEADER_OFFICE_SCHEMA;
  status: LeaderDecisionStatus;
  killed: boolean;
  world: LeaderWorldView;
  context: LeaderContextView | null;
  grant: { mode: 'apply' | 'propose'; reason: string };
  escalation: LeaderEscalation | null;
  route: LeaderRoute | null;
  assignment: LeaderAssignment | null;
  holder: WorkHolder | null;
  reply: { id: string; text: string; to: 'owner' } | null;
  bus: { posted: boolean; ids: string[] };
}

export interface LeaderOfficeStatus {
  schema: typeof LEADER_OFFICE_SCHEMA;
  killed: boolean;
  world: LeaderWorldView;
  context: LeaderContextView | null;
  grant: { mode: 'apply' | 'propose'; reason: string };
  org: LeaderOrg;
  orgSource: 'override' | 'bundled' | 'default';
  priorities: LeaderAssignment[];
  inbox: LeaderOfficeMessage[];
  outbox: LeaderOfficeMessage[];
}

export interface LeaderOfficeDeps {
  root?: string;
  busRoot?: string;
  claimRoot?: string;
  orgPath?: string;
  now?: () => number;
  killed?: () => boolean;
  grant?: () => { mode: 'apply' | 'propose'; reason: string };
  readWorld?: () => Promise<WorldModel>;
  pulls?: readonly OpenWorkPull[];
}

/** Shipped chart. `config/leader-org.json` is the same document; an override at `org.json` replaces it. */
export const DEFAULT_LEADER_ORG: LeaderOrg = {
  schema: LEADER_ORG_SCHEMA,
  coordinatesWith: [
    {
      rq: 'RQ-SHARED-VISIBILITY-1',
      surface: 'phm context / phm claim',
      note: 'The leader reads the shared brief and claims work. It does not replace context or claim.',
    },
    {
      rq: 'RQ-COMMS-UNIFIED-1',
      surface: 'acceptOwnerMessage / readLeaderOutbox',
      note: 'Channel adapters authenticate the owner, then use this inbox and outbox. This office does not speak to a channel.',
    },
  ],
  roles: [
    { id: 'leader', title: 'Digital co-founder', owner: 'leader', lane: 'frontier', mission: 'Vision, direction, org structure, accountability and orchestration. Mason talks only to this role.', routes: [] },
    { id: 'engineering', title: 'Engineering', owner: 'engineering', lane: 'work', mission: 'Implement and fix the product.', routes: ['code', 'bug', 'test', 'repo', 'implement', 'fix', 'pr'] },
    { id: 'review', title: 'Review', owner: 'review', lane: 'mid', mission: 'Review changes and hold the quality bar.', routes: ['review', 'audit'] },
    { id: 'release', title: 'Release', owner: 'release', lane: 'work', mission: 'Ship through the sanctioned release workflow.', routes: ['release', 'publish', 'ship'] },
    { id: 'steward', title: 'Context and resources', owner: 'steward', lane: 'fast', mission: 'Context, disk and resource stewardship.', routes: ['disk', 'context', 'resource', 'cleanup'] },
  ],
};

const RULES: { category: EscalationCategory; reason: string; patterns: RegExp[] }[] = [
  { category: 'owner-data-destruction', reason: 'This would destroy owner data.', patterns: [/\b(delete|wipe|destroy|erase)\b.{0,48}\b(owner|mason)(?:'s|s)?\b.{0,24}\b(data|files|documents|mail|mailbox)\b/i, /\brm\s+-rf\b/i, /\bdestroy owner data\b/i] },
  { category: 'secrets', reason: 'This asks for a secret or a key.', patterns: [/\b(api[_ -]?key|secret key|private key|password|credential|passphrase|2fa|one-time password|seed phrase)\b/i, /\brotate (?:a |the )?(?:token|key|secret|credential)s?\b/i, /\b(?:sk-|ghp_|github_pat_|xox[baprs]-)/i] },
  { category: 'money', reason: 'This would spend money or change a paid plan.', patterns: [/\b(payment|billing|invoice|purchase|paid plan|wire transfer)\b/i, /\b(budget|spend|cost)\b.{0,40}\b(increase|raise|upgrade|authorize)\b/i, /\braise (?:the )?(?:spend|budget|paid plan)\b/i] },
  { category: 'outside-send', reason: 'This would send outside the owner\'s own channels.', patterns: [/\b(email|message|dm|tweet|post)\b.{0,48}\b(customer|client|publicly|externally|outside|twitter|linkedin)\b/i, /\bsend (?:an |a )?(?:email|message|dm) to\b/i, /\bpost (?:this |it )?publicly\b/i] },
];

export function escalationLabel(category: EscalationCategory): string {
  switch (category) {
    case 'secrets': return 'secrets/keys';
    case 'money': return 'money';
    case 'outside-send': return 'outside sends';
    case 'owner-data-destruction': return 'destruction of owner data';
    case 'unsure': return 'a hard limit';
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

/**
 * Label a phrase that already matches a hard-limit pattern.
 * This does not decide escalation. The office escalates unless the text is
 * clearly ordinary work; a miss here stays `unsure` and still goes to the owner.
 */
export function classifyEscalation(text: string): LeaderEscalation | null {
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return { category: rule.category, reason: rule.reason };
  }
  return null;
}

export function bundledLeaderOrgPath(): string {
  return fileURLToPath(new URL('../../../config/leader-org.json', import.meta.url));
}

function officeRoot(deps: LeaderOfficeDeps): string {
  return deps.root ?? join(homedir(), '.ashlr', 'vision', 'leader');
}

function isRouterLane(value: string): value is RouterLane {
  return (ROUTER_LANES as readonly string[]).includes(value);
}

function isAssignmentStatus(value: string): value is AssignmentStatus {
  return (ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

function validRole(value: unknown): value is LeaderRole {
  if (!value || typeof value !== 'object') return false;
  const role = value as LeaderRole;
  return typeof role.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(role.id)
    && typeof role.title === 'string' && role.title.length > 0 && role.title.length <= 80
    && typeof role.owner === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(role.owner)
    && typeof role.lane === 'string' && isRouterLane(role.lane)
    && typeof role.mission === 'string' && role.mission.length > 0 && role.mission.length <= 300
    && Array.isArray(role.routes) && role.routes.every((route) => typeof route === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(route));
}

function parseOrg(raw: unknown): LeaderOrg | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as LeaderOrg;
  if (body.schema !== LEADER_ORG_SCHEMA || !Array.isArray(body.roles) || body.roles.length < 1 || body.roles.length > 32) return null;
  if (!body.roles.every(validRole) || !body.roles.some((role) => role.id === 'leader')) return null;
  if (new Set(body.roles.map((role) => role.id)).size !== body.roles.length) return null;
  if (!Array.isArray(body.coordinatesWith) || body.coordinatesWith.length > 16) return null;
  for (const peer of body.coordinatesWith) {
    if (!peer || typeof peer.rq !== 'string' || !RQ.test(peer.rq) || typeof peer.surface !== 'string' || typeof peer.note !== 'string') return null;
  }
  return body;
}

export function loadLeaderOrg(deps: LeaderOfficeDeps = {}): { ok: true; org: LeaderOrg; source: 'override' | 'bundled' | 'default' } | { ok: false; reason: string } {
  const candidates: { path: string; source: 'override' | 'bundled' }[] = [];
  const override = deps.orgPath ?? join(officeRoot(deps), 'org.json');
  if (existsSync(override)) candidates.push({ path: override, source: 'override' });
  const bundled = bundledLeaderOrgPath();
  if (bundled !== override && existsSync(bundled)) candidates.push({ path: bundled, source: 'bundled' });
  for (const candidate of candidates) {
    try {
      const org = parseOrg(JSON.parse(readFileSync(candidate.path, 'utf8')));
      if (!org) return { ok: false, reason: 'invalid-org' };
      return { ok: true, org, source: candidate.source };
    } catch {
      return { ok: false, reason: 'invalid-org' };
    }
  }
  return { ok: true, org: DEFAULT_LEADER_ORG, source: 'default' };
}

const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'in', 'on', 'of', 'and', 'or', 'with', 'this', 'that', 'please', 'our', 'it', 'its', 'then']);
const WORK_WORDS = new Set(['fix', 'flaky', 'test', 'tests', 'build', 'leader', 'office', 'panel', 'open', 'pr', 'review', 'code', 'bug', 'repo', 'implement', 'audit', 'release', 'publish', 'ship', 'disk', 'context', 'resource', 'cleanup', 'engineering']);

/** Positive ordinary-work check. Unknown words are doubt, not a clearance. */
export function isClearOrdinaryWork(text: string): boolean {
  const words = text.replace(/\bRQ-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g, ' ').toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? [];
  return words.length > 0 && words.every((word) => FUNCTION_WORDS.has(word) || WORK_WORDS.has(word));
}

function hasRouteKeyword(org: LeaderOrg, text: string): boolean {
  return org.roles.some((role) => role.id !== 'leader' && role.routes.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text)));
}

function escalationFor(text: string, explicitRole: LeaderRole | null, org: LeaderOrg): LeaderEscalation | null {
  if (isClearOrdinaryWork(text) && (explicitRole !== null || hasRouteKeyword(org, text))) return null;
  return classifyEscalation(text) ?? { category: 'unsure', reason: 'This is not clearly ordinary work, so it comes to you.' };
}

function blankWorld(reason: string | null, model?: WorldModel): LeaderWorldView {
  if (!model) return { schema: null, generatedAt: null, blindSpotCount: null, unavailable: true, reason };
  return {
    schema: model.schema,
    generatedAt: model.generatedAt,
    blindSpotCount: model.blindSpots.length,
    unavailable: false,
    reason: null,
  };
}

interface Store {
  schema: typeof LEADER_OFFICE_SCHEMA;
  assignments: LeaderAssignment[];
  messages: LeaderOfficeMessage[];
}

function emptyStore(): Store {
  return { schema: LEADER_OFFICE_SCHEMA, assignments: [], messages: [] };
}

function storePath(deps: LeaderOfficeDeps): string {
  return join(officeRoot(deps), 'office.json');
}

function readStore(deps: LeaderOfficeDeps): Store | null {
  const path = storePath(deps);
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Store;
    if (!parsed || parsed.schema !== LEADER_OFFICE_SCHEMA || !Array.isArray(parsed.assignments) || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function killedNow(deps: LeaderOfficeDeps): boolean {
  return deps.killed ? deps.killed() : killSwitchOn();
}

function writeStore(deps: LeaderOfficeDeps, store: Store): boolean {
  if (killedNow(deps)) return false;
  const root = officeRoot(deps);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  store.assignments = store.assignments.slice(-STORE_CAP);
  store.messages = store.messages.slice(-STORE_CAP);
  writeFileSync(storePath(deps), JSON.stringify(store), { mode: 0o600 });
  return true;
}

function routeRole(org: LeaderOrg, text: string): LeaderRole {
  let best: { role: LeaderRole; length: number } | null = null;
  for (const role of org.roles) {
    if (role.id === 'leader') continue;
    for (const word of role.routes) {
      const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(text) && (!best || word.length > best.length)) best = { role, length: word.length };
    }
  }
  return best?.role ?? org.roles.find((role) => role.id === 'engineering') ?? org.roles[0]!;
}

function firstRq(text: string): string | null {
  const match = text.match(/\bRQ-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/);
  return match && RQ.test(match[0]) ? match[0] : null;
}

function grantOf(deps: LeaderOfficeDeps): { mode: 'apply' | 'propose'; reason: string } {
  if (deps.grant) return deps.grant();
  try {
    return currentStandingPolicy()
      ? { mode: 'apply', reason: 'standing-grant' }
      : { mode: 'propose', reason: 'no-standing-grant' };
  } catch {
    return { mode: 'propose', reason: 'grant-unreadable' };
  }
}

async function look(deps: LeaderOfficeDeps, now: number): Promise<{ world: LeaderWorldView; context: LeaderContextView | null; model: WorldModel | null }> {
  try {
    const model = await (deps.readWorld ?? readWorldModel)();
    const claims = listCoordination(deps.claimRoot, now);
    const brief = buildContextBrief({
      nowMs: Number.isFinite(Date.parse(model.generatedAt)) ? Date.parse(model.generatedAt) : now,
      lane: 'leader',
      world: model,
      claims: claims.claims,
      pulls: deps.pulls ?? [],
    });
    return {
      model,
      world: blankWorld(null, model),
      context: { schema: brief.schema, lane: brief.lane, bytes: brief.bytes, truncated: brief.truncated, blindSpots: brief.blindSpots.length, working: brief.working.length },
    };
  } catch {
    return { model: null, world: blankWorld('world-unavailable'), context: null };
  }
}

function scrubBody(body: Record<string, string | null>): Record<string, string | null> {
  const scrubbed: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(body)) scrubbed[key] = value === null ? null : scrubSecrets(value);
  return scrubbed;
}

function postBus(deps: LeaderOfficeDeps, now: number, envelope: { id: string; from: string; to: string; priority: 'P0' | 'P1'; body: Record<string, string | null> }): 'posted' | 'killed' | 'skipped' {
  if (killedNow(deps)) return 'killed';
  const posted = appendBusInbox({ ...envelope, ttl: BUS_TTL_MS, body: scrubBody(envelope.body) }, { root: deps.busRoot, now: () => now });
  return posted.status === 'posted' || posted.status === 'duplicate' ? 'posted' : 'skipped';
}

export interface LeaderAskInput { text: string }
export interface LeaderAssignInput {
  rq: string;
  owner: string;
  summary: string;
  due?: string | null;
  status?: string | null;
  outcome?: string | null;
}

function stopped(world: LeaderWorldView, context: LeaderContextView | null, grant: { mode: 'apply' | 'propose'; reason: string }): LeaderDecision {
  return {
    schema: LEADER_OFFICE_SCHEMA, status: 'stopped', killed: true, world, context, grant,
    escalation: null, route: null, assignment: null, holder: null, reply: null, bus: { posted: false, ids: [] },
  };
}

async function decide(deps: LeaderOfficeDeps, input: {
  text: string;
  rq: string | null;
  role: LeaderRole | null;
  due: string | null;
  nextStatus: AssignmentStatus | null;
  outcome: string | null;
  summary: string;
}): Promise<LeaderDecision> {
  const now = deps.now?.() ?? Date.now();
  const grant = grantOf(deps);
  const seen = await look(deps, now);
  if (killedNow(deps)) return stopped(seen.world, seen.context, grant);
  const loadedOrg = loadLeaderOrg(deps);
  const org = loadedOrg.ok ? loadedOrg.org : DEFAULT_LEADER_ORG;
  const escalation = escalationFor(`${input.summary}\n${input.text}`, input.role, org);
  const store = readStore(deps);
  if (!store) {
    return {
      schema: LEADER_OFFICE_SCHEMA, status: 'unavailable', killed: false, world: seen.world, context: seen.context, grant,
      escalation, route: null, assignment: null, holder: null, reply: null, bus: { posted: false, ids: [] },
    };
  }
  const at = new Date(now).toISOString();
  const id = randomBytes(8).toString('hex');
  const ids: string[] = [];
  const remember = (direction: 'in' | 'out', text: string, to: string, decision: string): void => {
    store.messages.push({ id: `lo-${direction}-${id}`, at, direction, text: scrubSecrets(text).slice(0, TEXT_MAX), to, rq: input.rq, decision });
  };
  const inboundText = escalation?.category === 'secrets' ? 'Escalated to the owner (secrets/keys).' : input.text;
  remember('in', inboundText, 'leader', escalation ? 'escalated' : 'accepted');
  const mirrorIn = (): 'killed' | 'open' => {
    const inbound = postBus(deps, now, {
      id: `lo-in-${id}`, from: 'owner', to: 'leader', priority: 'P0',
      body: { kind: 'leader.owner-message', rq: input.rq, text: scrubSecrets(inboundText).slice(0, 500) },
    });
    if (inbound === 'killed') return 'killed';
    if (inbound === 'posted') ids.push(`lo-in-${id}`);
    return 'open';
  };

  if (escalation) {
    if (mirrorIn() === 'killed') return stopped(seen.world, seen.context, grant);
    const assignment = input.rq ? upsert(store, {
      rq: input.rq, owner: 'leader', lane: 'frontier', due: input.due, status: 'escalated', outcome: null,
      summary: escalationLabel(escalation.category), updatedAt: at,
    }) : null;
    const reply = `This needs you (${escalationLabel(escalation.category)}). I will not do it. ${escalation.reason}`;
    remember('out', reply, 'owner', 'escalated');
    const out = postBus(deps, now, {
      id: `lo-out-${id}`, from: 'leader', to: 'owner', priority: 'P0',
      body: { kind: 'leader.escalation', rq: input.rq, category: escalation.category, text: reply },
    });
    if (out === 'killed') return stopped(seen.world, seen.context, grant);
    if (out === 'posted') ids.push(`lo-out-${id}`);
    if (!writeStore(deps, store)) return stopped(seen.world, seen.context, grant);
    return {
      schema: LEADER_OFFICE_SCHEMA, status: 'escalated', killed: false, world: seen.world, context: seen.context, grant,
      escalation, route: null, assignment, holder: null, reply: { id: `lo-out-${id}`, text: reply, to: 'owner' },
      bus: { posted: ids.length > 0, ids },
    };
  }

  const role = input.role ?? routeRole(org, input.text);
  const route: LeaderRoute = { via: 'existing-router', tier: role.lane, roleId: role.id, busTo: role.owner, spend: 'none' };
  if (grant.mode === 'propose') {
    const assignment = input.rq ? upsert(store, {
      rq: input.rq, owner: role.id, lane: role.lane, due: input.due, status: 'proposed', outcome: input.outcome,
      summary: input.summary, updatedAt: at,
    }) : null;
    const reply = `Recorded as a proposal for ${role.title}. A standing grant is required before I put it on the bus.`;
    remember('out', reply, 'owner', 'proposed');
    if (!writeStore(deps, store)) return stopped(seen.world, seen.context, grant);
    return {
      schema: LEADER_OFFICE_SCHEMA, status: 'proposed', killed: false, world: seen.world, context: seen.context, grant,
      escalation: null, route, assignment, holder: null, reply: { id: `lo-out-${id}`, text: reply, to: 'owner' },
      bus: { posted: ids.length > 0, ids },
    };
  }

  if (mirrorIn() === 'killed') return stopped(seen.world, seen.context, grant);
  let holder: WorkHolder | null = null;
  let status: AssignmentStatus = input.nextStatus ?? 'assigned';
  if (input.rq && status !== 'done') {
    const claimed = acquireWorkClaim({
      workKey: input.rq, lane: role.id, pulls: deps.pulls, root: deps.claimRoot, now,
    });
    if (claimed.status === 'conflict') {
      status = 'blocked';
      holder = claimed.holder ?? null;
    }
  }
  if (input.rq && status === 'done') {
    releaseWorkClaim({ workKey: input.rq, lane: role.id, reason: 'merge', root: deps.claimRoot, now });
  }
  const assignment = input.rq ? upsert(store, {
    rq: input.rq, owner: role.id, lane: role.lane, due: input.due, status, outcome: input.outcome,
    summary: input.summary, updatedAt: at,
  }) : null;
  const reply = status === 'blocked'
    ? `${input.rq} is already held${holder?.lane ? ` by ${holder.lane}` : ''}. I did not take it.`
    : `${input.rq ? `Assigned ${input.rq}` : 'Routed this'} to ${role.title} (${role.owner}) on the ${role.lane} lane through the existing router. No new model spend.`;
  remember('out', reply, 'owner', status === 'blocked' ? 'blocked' : 'routed');
  if (status !== 'blocked') {
    const routed = postBus(deps, now, {
      id: `lo-route-${id}`, from: 'leader', to: role.owner, priority: 'P1',
      body: { kind: 'leader.assignment', rq: input.rq, lane: role.lane, text: scrubSecrets(input.summary).slice(0, 500) },
    });
    if (routed === 'killed') return stopped(seen.world, seen.context, grant);
    if (routed === 'posted') ids.push(`lo-route-${id}`);
  }
  const out = postBus(deps, now, {
    id: `lo-out-${id}`, from: 'leader', to: 'owner', priority: 'P1',
    body: { kind: 'leader.reply', rq: input.rq, text: reply },
  });
  if (out === 'killed') return stopped(seen.world, seen.context, grant);
  if (out === 'posted') ids.push(`lo-out-${id}`);
  if (!writeStore(deps, store)) return stopped(seen.world, seen.context, grant);
  return {
    schema: LEADER_OFFICE_SCHEMA, status: status === 'blocked' ? 'blocked' : 'routed', killed: false,
    world: seen.world, context: seen.context, grant, escalation: null, route, assignment, holder,
    reply: { id: `lo-out-${id}`, text: reply, to: 'owner' }, bus: { posted: ids.length > 0, ids },
  };
}

function upsert(store: Store, next: LeaderAssignment): LeaderAssignment {
  const index = store.assignments.findIndex((row) => row.rq === next.rq);
  const prior = index >= 0 ? store.assignments[index]! : null;
  const outcome = next.outcome ?? prior?.outcome ?? null;
  const merged: LeaderAssignment = {
    ...next,
    due: next.due ?? prior?.due ?? null,
    summary: scrubSecrets(next.summary || prior?.summary || next.rq),
    outcome: outcome === null ? null : scrubSecrets(outcome),
  };
  if (index >= 0) store.assignments[index] = merged;
  else store.assignments.push(merged);
  return merged;
}

function cleanText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > TEXT_MAX) return null;
  if ([...trimmed].some((char) => char.charCodeAt(0) < 32 && char !== '\n' && char !== '\t')) return null;
  return scrubSecrets(trimmed);
}

export async function leaderAsk(input: LeaderAskInput, deps: LeaderOfficeDeps = {}): Promise<LeaderDecision> {
  const text = cleanText(input.text);
  if (!text) {
    const now = deps.now?.() ?? Date.now();
    const seen = await look(deps, now);
    return {
      schema: LEADER_OFFICE_SCHEMA, status: 'refused', killed: deps.killed?.() ?? false, world: seen.world, context: seen.context,
      grant: grantOf(deps), escalation: null, route: null, assignment: null, holder: null, reply: null, bus: { posted: false, ids: [] },
    };
  }
  const org = loadLeaderOrg(deps);
  if (!org.ok) {
    const now = deps.now?.() ?? Date.now();
    const seen = await look(deps, now);
    return {
      schema: LEADER_OFFICE_SCHEMA, status: 'refused', killed: false, world: seen.world, context: seen.context, grant: grantOf(deps),
      escalation: null, route: null, assignment: null, holder: null, reply: null, bus: { posted: false, ids: [] },
    };
  }
  return decide(deps, {
    text, rq: firstRq(text), role: null, due: null, nextStatus: null, outcome: null, summary: text.slice(0, SUMMARY_MAX),
  });
}

export async function leaderAssign(input: LeaderAssignInput, deps: LeaderOfficeDeps = {}): Promise<LeaderDecision> {
  const summary = cleanText(input.summary);
  const org = loadLeaderOrg(deps);
  const role = org.ok ? org.org.roles.find((item) => item.id === input.owner) ?? null : null;
  const due = input.due ?? null;
  const outcome = input.outcome ?? null;
  const nextStatus = input.status ?? null;
  if (!summary || !RQ.test(input.rq) || !role || role.id === 'leader'
    || (due !== null && (!DUE.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))))
    || (outcome !== null && (outcome.length < 1 || outcome.length > SUMMARY_MAX))
    || (nextStatus !== null && (!isAssignmentStatus(nextStatus) || nextStatus === 'escalated'))) {
    const now = deps.now?.() ?? Date.now();
    const seen = await look(deps, now);
    return {
      schema: LEADER_OFFICE_SCHEMA, status: 'refused', killed: false, world: seen.world, context: seen.context, grant: grantOf(deps),
      escalation: null, route: null, assignment: null, holder: null, reply: null, bus: { posted: false, ids: [] },
    };
  }
  return decide(deps, { text: summary, rq: input.rq, role, due, nextStatus, outcome, summary });
}

export async function leaderStatus(deps: LeaderOfficeDeps = {}): Promise<LeaderOfficeStatus | { schema: typeof LEADER_OFFICE_SCHEMA; status: 'unavailable' | 'refused'; reason: string }> {
  const org = loadLeaderOrg(deps);
  if (!org.ok) return { schema: LEADER_OFFICE_SCHEMA, status: 'refused', reason: org.reason };
  const now = deps.now?.() ?? Date.now();
  const seen = await look(deps, now);
  const store = readStore(deps);
  if (!store) return { schema: LEADER_OFFICE_SCHEMA, status: 'unavailable', reason: 'office-unreadable' };
  const open = new Set<AssignmentStatus>(['proposed', 'assigned', 'in_progress', 'blocked', 'escalated']);
  return {
    schema: LEADER_OFFICE_SCHEMA,
    killed: deps.killed ? deps.killed() : killSwitchOn(),
    world: seen.world,
    context: seen.context,
    grant: grantOf(deps),
    org: org.org,
    orgSource: org.source,
    priorities: store.assignments.filter((row) => open.has(row.status)),
    inbox: store.messages.filter((row) => row.direction === 'in'),
    outbox: store.messages.filter((row) => row.direction === 'out'),
  };
}

export function leaderOrg(deps: LeaderOfficeDeps = {}): { schema: typeof LEADER_OFFICE_SCHEMA; org: LeaderOrg; source: 'override' | 'bundled' | 'default' } | { schema: typeof LEADER_OFFICE_SCHEMA; status: 'refused'; reason: string } {
  const org = loadLeaderOrg(deps);
  if (!org.ok) return { schema: LEADER_OFFICE_SCHEMA, status: 'refused', reason: org.reason };
  return { schema: LEADER_OFFICE_SCHEMA, org: org.org, source: org.source };
}

/**
 * Owner message in. The caller must already have authenticated the owner.
 * Do not pass a raw channel payload; verified-sender adapters are the only callers.
 */
export async function acceptOwnerMessage(message: { text: string; receivedAt?: string }, deps: LeaderOfficeDeps = {}): Promise<LeaderDecision> {
  if (message.receivedAt !== undefined && Number.isNaN(Date.parse(message.receivedAt))) {
    return leaderAsk({ text: '' }, deps);
  }
  return leaderAsk({ text: message.text }, deps);
}

export function readLeaderOutbox(deps: LeaderOfficeDeps = {}): { schema: typeof LEADER_OFFICE_SCHEMA; entries: LeaderOfficeMessage[] } {
  const store = readStore(deps);
  return { schema: LEADER_OFFICE_SCHEMA, entries: store ? store.messages.filter((row) => row.direction === 'out') : [] };
}

export function readLeaderOfficeInbox(deps: LeaderOfficeDeps = {}): { schema: typeof LEADER_OFFICE_SCHEMA; entries: LeaderOfficeMessage[] } {
  const store = readStore(deps);
  return { schema: LEADER_OFFICE_SCHEMA, entries: store ? store.messages.filter((row) => row.direction === 'in') : [] };
}
