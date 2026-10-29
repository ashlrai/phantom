/**
 * core/fleet/graph-seed.ts — RQ-GRAPH-1B: the fleet's graph.v1 seeder.
 *
 * Builds a `graph.v1` seed document — the initial node set a graph store
 * ingests — from two evidence sources:
 *
 *   fleet.json   ~/.ashlr/fleet/fleet.json — the fleet's inventory file:
 *                declared repos, dispatch lanes, seat bindings and repo
 *                holds, in fleet-types.ts vocabulary (`RepoStage`,
 *                `FleetEngine`, `RepoHoldKind`, `FleetActor`).
 *   phm seats    the seat inventory `phm` reports — the PUBLIC `VerseSeat[]`
 *                half of `discoverSeats` (verse/seats.ts), or equivalent
 *                seat rows. Never `launches`.
 *
 * REFS ONLY
 * ---------
 * A node carries identifiers and scalar refs — never payloads. Two rules
 * enforce it:
 *
 *   1. Whitelisted refs. Each section admits a fixed ref-field set; the
 *      values must be scalars (string / number / boolean / null). A
 *      whitelisted name carrying an object or array REJECTS the record —
 *      a "ref" that holds a payload is not a ref. Unlisted fields are never
 *      copied, so a native seat's launcher `command` / `env` (its identity —
 *      the verse/seats.ts privacy boundary) cannot reach a node even when a
 *      caller hands the private half over by mistake.
 *   2. Secret-like field names are REJECTED WHOLESALE. Any record — in any
 *      section, or any seat row — carrying a key like `apiKey`,
 *      `client_secret`, `accessToken`, `password`, `sshKey` or `env` is
 *      dropped entirely and a `secret-field` issue is recorded. Refs are
 *      never filtered around secrets: the record does not seed at all.
 *
 * NEVER THROWS. Every reader is guarded; the builder returns a complete
 * seed (`complete: true`) only when no issue was recorded.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  FLEET_ACTORS,
  FLEET_ENGINES,
  REPO_HOLD_KINDS,
  type FleetEngine,
  type RepoStage,
} from './fleet-types.js';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// graph.v1 document
// ---------------------------------------------------------------------------

/** The seed document's kind discriminator — the format the job names. */
export const FLEET_GRAPH_SEED_KIND = 'graph.v1' as const;

export const FLEET_GRAPH_SEED_LIMITS = Object.freeze({
  /** A seeder seeds, it does not scan: per-section input is bounded. */
  maxSectionRecords: 512,
  maxNodes: 5_000,
  maxEdges: 10_000,
  maxIssues: 128,
  /** One ref value may never carry more than this — refs name, they do not narrate. */
  maxRefChars: 160,
  /** fleet.json is an inventory, never an artifact. */
  maxFileBytes: 256 * 1024,
});

export type FleetGraphNodeKind = 'fleet' | 'repo' | 'lane' | 'seat' | 'hold';
export type FleetGraphEdgeKind = 'contains' | 'serves' | 'binds' | 'holds';

export interface FleetGraphNodeV1 {
  v: 1;
  /** Deterministic ref-derived id: `kind:<name>` (`hold` adds its kind). */
  id: string;
  kind: FleetGraphNodeKind;
  label: string;
  /**
   * Identifier scalars only — repo names, lane ids, seat ids, enum members.
   * No objects, no arrays, no copied payloads.
   */
  refs: Record<string, string | number | boolean>;
  /** Which evidence sources claim this node. */
  source: 'fleet.json' | 'phm-seats' | 'both';
  /** `recorded` = read from evidence; `declared` = asserted by fleet.json alone. */
  evidence: 'recorded' | 'declared';
}

export interface FleetGraphEdgeV1 {
  id: string;
  from: string;
  to: string;
  /**
   * `contains` fleet→repo / fleet→lane · `serves` seat→lane (the seat's
   * engine maps onto a declared dispatch lane) · `binds` seat→lane (a
   * fleet.json binding asserted it) · `holds` hold→repo.
   */
  kind: FleetGraphEdgeKind;
}

export interface FleetGraphSeedIssue {
  code:
    | 'malformed'        // fleet.json is not an object / a section is not an array / a record is not an object
    | 'bad-version'      // `v` present and not 1
    | 'secret-field'     // record carried a secret-like field name — rejected whole
    | 'bad-ref'          // required ref absent/invalid, or a ref field holds a non-scalar
    | 'duplicate-ref'    // two records claim the same node identity; first wins
    | 'unresolved-edge'  // a recorded relationship points at no included node
    | 'graph-limit';     // a bound was hit; the projection is incomplete
  /** One specific sentence. Never carries field values. */
  message: string;
  nodeIds: string[];
}

export interface FleetGraphSeedV1 {
  v: 1;
  kind: typeof FLEET_GRAPH_SEED_KIND;
  generatedAt: string;
  /** True only when no issue was recorded (like universe/graph.ts). */
  complete: boolean;
  sources: {
    fleetJson: { state: 'absent' | 'loaded' | 'malformed'; path: string | null };
    seats: { state: 'absent' | 'loaded'; count: number };
  };
  nodes: FleetGraphNodeV1[];
  edges: FleetGraphEdgeV1[];
  issues: FleetGraphSeedIssue[];
  counts: { nodes: number; edges: number; repos: number; lanes: number; seats: number; holds: number; rejected: number };
  limits: { maxNodes: number; maxEdges: number };
}

// ---------------------------------------------------------------------------
// fleet.json — the inventory file's input contract
// ---------------------------------------------------------------------------

/**
 * The file is a small `v: 1` JSON document. Every section is optional; every
 * record is a plain object whose allowed fields are exactly the ref names in
 * SECTION_REFS below (any extra field is ignored — never copied — unless its
 * name is secret-like, which rejects the record).
 *
 *   {
 *     "v": 1,
 *     "repos": [ { "repo": "ashlrai/phantom", "stage": "merge",
 *                  "enforcement": "server", "path": "/abs/checkout" } ],
 *     "lanes": [ { "lane": "codex", "slots": 2 } ],
 *     "seats": [ { "seat": "codex-personal", "lane": "codex" } ],
 *     "holds": [ { "repo": "ashlrai/phantom", "kind": "owner-hold",
 *                  "reason": "…", "since": "…", "until": null,
 *                  "setBy": "mason", "landingId": "…" } ]
 *   }
 */
export interface FleetInventoryFileV1 {
  v?: 1;
  generatedAt?: string;
  repos?: unknown[];
  lanes?: unknown[];
  seats?: unknown[];
  holds?: unknown[];
}

/**
 * The seat rows the `phm seats` side accepts. Structurally satisfied by
 * `VerseSeat` (its `engine`, `accountId`, `label`, `health.state`,
 * `cliVersion`, `costBasis`, `models[0].id` project into refs; everything
 * else — `capacity`, `windows`, `lastKnownUsage`, launch data — is not a
 * ref and is never copied).
 */
export interface FleetGraphSeatInput {
  id?: unknown;
  seat?: unknown;
  engine?: unknown;
  label?: unknown;
  account?: unknown;
  accountId?: unknown;
  model?: unknown;
  models?: unknown;
  health?: unknown;
  cliVersion?: unknown;
  costBasis?: unknown;
  [key: string]: unknown;
}

export interface FleetGraphSeedInput {
  /** Parsed fleet.json content — validated field by field; `undefined` = no readable inventory. */
  fleet?: unknown;
  /** The phm seat inventory (VerseSeat[] or raw seat rows). */
  seats?: readonly unknown[];
  /** Provenance only — stamped on sources.fleetJson.path; never read. */
  fleetJsonPath?: string;
}

export interface FleetGraphSeedDeps {
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Ref policy
// ---------------------------------------------------------------------------

type InventorySection = 'repos' | 'lanes' | 'seats' | 'holds';

/**
 * The only field names a section's records may carry into `node.refs`.
 * Everything else is ignored outright; a secret-like name rejects the
 * record (see isSecretLikeFieldName). `reason` is a ref here only because
 * RepoHold already bounds it to a scrubbed one-line sentence — the same
 * string the Fleet surface shows.
 */
const SECTION_REFS: Record<InventorySection, ReadonlySet<string>> = {
  repos: new Set(['repo', 'stage', 'enforcement', 'path']),
  lanes: new Set(['lane', 'slots', 'busy', 'capReason']),
  seats: new Set(['seat', 'id', 'lane', 'engine', 'account', 'accountId', 'model', 'label', 'health', 'cliVersion', 'costBasis']),
  holds: new Set(['repo', 'kind', 'since', 'until', 'setBy', 'landingId', 'reason']),
};

/** phm seat rows admit the same refs as a fleet.json seat binding. */
const SEAT_REFS: ReadonlySet<string> = SECTION_REFS.seats;

/** phm seat engine → the fleet dispatch lane that engine drives (`serves` edges). */
const SEAT_ENGINE_LANE: Readonly<Record<string, FleetEngine>> = {
  claude: 'claude-cli',
  codex: 'codex',
  grok: 'grok-cli',
  local: 'local',
  devin: 'devin-cli',
};

/**
 * Secret-like field names, matched on the NORMALIZED name (lowercased,
 * non-alphanumerics stripped, so `api_key` / `api-key` / `apiKey` agree).
 * Fail closed by design: `token` also names `tokens`/`tokenCount`,
 * `key`-suffix also names `publicKey`. A fleet inventory has no legitimate
 * use for any of them — if it did, that field would be a payload, not a ref.
 * `env` matches only as a whole name (the launcher env map), not as a
 * substring (`environment` is fine).
 */
const SECRET_LIKE_NAME = /(?:secret|token|password|passwd|passphrase|pwd|credential|bearer|cookie|oauth|jwt|pem|authcode|authkey)/;
const SECRET_LIKE_EXACT = new Set(['env', 'key', 'pass']);
export function isSecretLikeFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === '') return false;
  return normalized.endsWith('key') || SECRET_LIKE_EXACT.has(normalized) || SECRET_LIKE_NAME.test(normalized);
}

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
}

/** A ref string: non-empty, trimmed-stable, bounded, no control characters. */
function refString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() !== value || value === '') return null;
  if (value.length > FLEET_GRAPH_SEED_LIMITS.maxRefChars) return null;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return null;
  }
  return value;
}

function enumMember<T extends string>(value: unknown, members: readonly T[]): T | null {
  return typeof value === 'string' && (members as readonly string[]).includes(value) ? (value as T) : null;
}

/** Opaque issue identity keeps messages honest without quoting values. */
function fieldDigest(record: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(record).sort())).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// The builder — pure over injected input
// ---------------------------------------------------------------------------

/**
 * Build the graph.v1 seed. Pure and total: malformed input degrades to a
 * flagged, still-parseable projection — it never throws and never reads I/O.
 */
export function buildFleetGraphSeed(input: FleetGraphSeedInput = {}, deps: FleetGraphSeedDeps = {}): FleetGraphSeedV1 {
  const generatedAt = (deps.now?.() ?? new Date()).toISOString();
  const seed: FleetGraphSeedV1 = {
    v: 1,
    kind: FLEET_GRAPH_SEED_KIND,
    generatedAt,
    complete: true,
    sources: {
      fleetJson: { state: 'absent', path: input.fleetJsonPath ?? null },
      seats: { state: 'absent', count: 0 },
    },
    nodes: [],
    edges: [],
    issues: [],
    counts: { nodes: 0, edges: 0, repos: 0, lanes: 0, seats: 0, holds: 0, rejected: 0 },
    limits: { maxNodes: FLEET_GRAPH_SEED_LIMITS.maxNodes, maxEdges: FLEET_GRAPH_SEED_LIMITS.maxEdges },
  };
  const nodes = new Map<string, FleetGraphNodeV1>();
  const edges = new Set<string>();
  let rejected = 0;
  let capped = false;

  const issue = (code: FleetGraphSeedIssue['code'], message: string, nodeIds: string[] = []): void => {
    seed.complete = false;
    if (seed.issues.length >= FLEET_GRAPH_SEED_LIMITS.maxIssues) return;
    if (seed.issues.some((item) => item.code === code && item.message === message && item.nodeIds.join() === nodeIds.join())) return;
    seed.issues.push({ code, message, nodeIds });
  };
  const reject = (code: FleetGraphSeedIssue['code'], message: string): void => {
    rejected += 1;
    issue(code, message);
  };
  const addNode = (node: FleetGraphNodeV1): boolean => {
    if (nodes.has(node.id)) {
      issue('duplicate-ref', `Two records claim node ${node.id}; the first was kept.`, [node.id]);
      return false;
    }
    if (nodes.size >= seed.limits.maxNodes) {
      if (!capped) { capped = true; issue('graph-limit', 'Graph node limit reached; this seed is incomplete.'); }
      return false;
    }
    nodes.set(node.id, node);
    seed.nodes.push(node);
    return true;
  };
  const addEdge = (from: string, to: string, kind: FleetGraphEdgeKind): void => {
    const id = `edge:${createHash('sha256').update(`${kind}${from}${to}`).digest('hex').slice(0, 16)}`;
    if (edges.has(id)) return;
    if (edges.size >= seed.limits.maxEdges) {
      if (!capped) { capped = true; issue('graph-limit', 'Graph edge limit reached; this seed is incomplete.'); }
      return;
    }
    edges.add(id);
    seed.edges.push({ id, from, to, kind });
  };

  const root: FleetGraphNodeV1 = {
    v: 1, id: 'fleet:root', kind: 'fleet', label: 'Fleet',
    refs: {}, source: 'fleet.json', evidence: 'recorded',
  };
  nodes.set(root.id, root);
  seed.nodes.push(root);

  // -- Secret-scan first: a record carrying any secret-like name is dropped
  //    whole, whichever section it sat in.
  const secretFieldOf = (record: Record<string, unknown>): string | null => {
    for (const key of Object.keys(record)) if (isSecretLikeFieldName(key)) return key;
    return null;
  };

  const section = (fleet: Record<string, unknown>, name: InventorySection): unknown[] => {
    const raw = fleet[name];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      issue('malformed', `fleet.json section "${name}" is not an array; it was skipped.`);
      return [];
    }
    if (raw.length > FLEET_GRAPH_SEED_LIMITS.maxSectionRecords) {
      issue('graph-limit', `fleet.json section "${name}" exceeds ${FLEET_GRAPH_SEED_LIMITS.maxSectionRecords} records; the tail was dropped.`);
    }
    return raw.slice(0, FLEET_GRAPH_SEED_LIMITS.maxSectionRecords);
  };

  /**
   * Project one record's allowed refs. Returns null (rejection already
   * recorded) on a non-scalar or invalid listed ref. Unlisted fields are
   * ignored — they are not refs — unless their names are secret-like, which
   * the caller has already rejected.
   */
  const projectRefs = (
    record: Record<string, unknown>,
    sectionName: InventorySection,
    required: readonly string[],
    enums: Readonly<Record<string, readonly string[]>>,
    where: string,
  ): Record<string, string | number | boolean> | null => {
    const allowed = SECTION_REFS[sectionName];
    const refs: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!allowed.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (!isScalar(value)) {
        reject('bad-ref', `${where} carries ref "${key}" as a non-scalar payload; the record was rejected (digest ${fieldDigest(record)}).`);
        return null;
      }
      const members = enums[key];
      if (members !== undefined) {
        const member = enumMember(value, members);
        if (member === null) {
          reject('bad-ref', `${where} carries an invalid "${key}" value; the record was rejected (digest ${fieldDigest(record)}).`);
          return null;
        }
        refs[key] = member;
        continue;
      }
      if (typeof value === 'string') {
        const text = refString(value);
        if (text === null) {
          reject('bad-ref', `${where} carries an unusable "${key}" ref; the record was rejected (digest ${fieldDigest(record)}).`);
          return null;
        }
        refs[key] = text;
        continue;
      }
      refs[key] = value;
    }
    for (const key of required) {
      if (refs[key] === undefined) {
        reject('bad-ref', `${where} omits required ref "${key}"; the record was rejected (digest ${fieldDigest(record)}).`);
        return null;
      }
    }
    return refs;
  };

  const laneIds = new Set<string>();
  const seatById = new Map<string, FleetGraphNodeV1>();

  const fleet = isPlainObject(input.fleet) ? input.fleet : undefined;
  if (input.fleet !== undefined && fleet === undefined) {
    seed.sources.fleetJson.state = 'malformed';
    issue('malformed', 'fleet.json is not a JSON object; only seat evidence was seeded.');
  } else if (fleet !== undefined) {
    seed.sources.fleetJson.state = 'loaded';
    if (fleet['v'] !== undefined && fleet['v'] !== 1) {
      issue('bad-version', 'fleet.json declares an unsupported version; known sections were still read.');
    }
  }

  // -- repos ---------------------------------------------------------------
  for (const record of section(fleet ?? {}, 'repos')) {
    const where = 'A fleet.json repos[] record';
    if (!isPlainObject(record)) { reject('malformed', `${where} is not an object; it was rejected.`); continue; }
    const secret = secretFieldOf(record);
    if (secret !== null) {
      reject('secret-field', `${where} carries a secret-like field name ("${secret}"); the record was rejected (digest ${fieldDigest(record)}).`);
      continue;
    }
    const refs = projectRefs(record, 'repos', ['repo'], {
      stage: ['propose', 'merge'] satisfies RepoStage[],
      enforcement: ['server', 'local'],
    }, where);
    if (refs === null) continue;
    addNode({
      v: 1, id: `repo:${refs['repo']}`, kind: 'repo', label: String(refs['repo']),
      refs, source: 'fleet.json', evidence: 'declared',
    });
  }

  // -- lanes ---------------------------------------------------------------
  for (const record of section(fleet ?? {}, 'lanes')) {
    const where = 'A fleet.json lanes[] record';
    if (!isPlainObject(record)) { reject('malformed', `${where} is not an object; it was rejected.`); continue; }
    const secret = secretFieldOf(record);
    if (secret !== null) {
      reject('secret-field', `${where} carries a secret-like field name ("${secret}"); the record was rejected (digest ${fieldDigest(record)}).`);
      continue;
    }
    const refs = projectRefs(record, 'lanes', ['lane'], { lane: FLEET_ENGINES }, where);
    if (refs === null) continue;
    const node: FleetGraphNodeV1 = {
      v: 1, id: `lane:${refs['lane']}`, kind: 'lane', label: `Lane ${String(refs['lane'])}`,
      refs, source: 'fleet.json', evidence: 'declared',
    };
    if (addNode(node)) laneIds.add(String(refs['lane']));
  }

  // -- holds ---------------------------------------------------------------
  const holdNodes: { id: string; repo: string }[] = [];
  for (const record of section(fleet ?? {}, 'holds')) {
    const where = 'A fleet.json holds[] record';
    if (!isPlainObject(record)) { reject('malformed', `${where} is not an object; it was rejected.`); continue; }
    const secret = secretFieldOf(record);
    if (secret !== null) {
      reject('secret-field', `${where} carries a secret-like field name ("${secret}"); the record was rejected (digest ${fieldDigest(record)}).`);
      continue;
    }
    const refs = projectRefs(record, 'holds', ['repo', 'kind'], {
      kind: REPO_HOLD_KINDS,
      setBy: FLEET_ACTORS,
    }, where);
    if (refs === null) continue;
    const id = `hold:${String(refs['repo'])}:${String(refs['kind'])}`;
    if (addNode({
      v: 1, id, kind: 'hold', label: `${String(refs['kind'])} on ${String(refs['repo'])}`,
      refs, source: 'fleet.json', evidence: 'declared',
    })) holdNodes.push({ id, repo: String(refs['repo']) });
  }

  // -- phm seats -----------------------------------------------------------
  const seatInputs = input.seats ?? [];
  seed.sources.seats = { state: input.seats !== undefined ? 'loaded' : 'absent', count: 0 };
  const seatSlice = seatInputs.slice(0, FLEET_GRAPH_SEED_LIMITS.maxSectionRecords * 8);
  if (seatInputs.length > seatSlice.length) {
    issue('graph-limit', `The phm seat inventory exceeds ${seatSlice.length} rows; the tail was dropped.`);
  }
  for (const record of seatSlice) {
    const where = 'A phm seats row';
    if (!isPlainObject(record)) { reject('malformed', `${where} is not an object; it was rejected.`); continue; }
    const secret = secretFieldOf(record);
    if (secret !== null) {
      reject('secret-field', `${where} carries a secret-like field name ("${secret}"); the row was rejected (digest ${fieldDigest(record)}).`);
      continue;
    }
    const seatId = refString(record['id'] ?? record['seat']);
    const engine = refString(record['engine']);
    if (seatId === null || engine === null) {
      reject('bad-ref', `${where} omits a usable "id"/"engine" ref; the row was rejected (digest ${fieldDigest(record)}).`);
      continue;
    }
    const refs: Record<string, string | number | boolean> = { seat: seatId, engine };
    for (const key of SEAT_REFS) {
      if (key === 'seat' || key === 'id' || key === 'engine') continue;
      const value = record[key];
      if (value === null || value === undefined) continue;
      if (key === 'health') {
        // VerseSeat.health is an object — the seat's STATE string is the ref.
        if (isPlainObject(value) && typeof value['state'] === 'string' && refString(value['state']) !== null) refs['health'] = value['state'];
        else if (typeof value === 'string' && refString(value) !== null) refs['health'] = value;
        continue;
      }
      if (!isScalar(value)) continue;
      if (typeof value === 'string' && refString(value) === null) continue;
      refs[key === 'accountId' ? 'account' : key] = value;
    }
    const models = record['models'];
    if (refs['model'] === undefined && Array.isArray(models)) {
      const first = models[0] as unknown;
      if (isPlainObject(first)) {
        const modelId = refString(first['id']);
        if (modelId !== null) refs['model'] = modelId;
      }
    }
    const id = `seat:${seatId}`;
    const existing = seatById.get(id);
    if (existing) {
      // A second discovered row for the same seat folds into the first.
      Object.assign(existing.refs, refs);
      if (typeof record['label'] === 'string' && refString(record['label']) !== null) existing.label = record['label'];
      continue;
    }
    const node: FleetGraphNodeV1 = {
      v: 1, id, kind: 'seat',
      label: typeof record['label'] === 'string' && refString(record['label']) !== null ? record['label'] : seatId,
      refs, source: 'phm-seats', evidence: 'recorded',
    };
    if (addNode(node)) seatById.set(id, node);
  }

  // -- declared seat bindings (fleet.json seats[]) --------------------------
  const binds: { node: string; lane: string }[] = [];
  for (const record of section(fleet ?? {}, 'seats')) {
    const where = 'A fleet.json seats[] record';
    if (!isPlainObject(record)) { reject('malformed', `${where} is not an object; it was rejected.`); continue; }
    const secret = secretFieldOf(record);
    if (secret !== null) {
      reject('secret-field', `${where} carries a secret-like field name ("${secret}"); the record was rejected (digest ${fieldDigest(record)}).`);
      continue;
    }
    const refs = projectRefs(record, 'seats', ['seat'], { lane: FLEET_ENGINES }, where);
    if (refs === null) continue;
    const seatId = String(refs['seat']);
    const id = `seat:${seatId}`;
    const lane = typeof refs['lane'] === 'string' ? refs['lane'] : null;
    const existing = seatById.get(id);
    if (existing) {
      // The binding declared what discovery recorded — fold the lane in.
      if (lane !== null && existing.refs['lane'] === undefined) existing.refs['lane'] = lane;
      if (existing.source === 'phm-seats') existing.source = 'both';
      if (lane !== null) binds.push({ node: id, lane });
      continue;
    }
    const node: FleetGraphNodeV1 = {
      v: 1, id, kind: 'seat', label: typeof refs['label'] === 'string' ? refs['label'] : seatId,
      refs, source: 'fleet.json', evidence: 'declared',
    };
    if (addNode(node)) {
      seatById.set(id, node);
      if (lane !== null) binds.push({ node: id, lane });
    }
  }

  // -- edges ---------------------------------------------------------------
  for (const node of seed.nodes) {
    if (node.kind === 'repo' || node.kind === 'lane') addEdge('fleet:root', node.id, 'contains');
  }
  for (const [id, node] of seatById) {
    const engine = typeof node.refs['engine'] === 'string' ? node.refs['engine'] : null;
    const lane = engine === null ? undefined : SEAT_ENGINE_LANE[engine];
    if (lane !== undefined && laneIds.has(lane)) addEdge(id, `lane:${lane}`, 'serves');
  }
  for (const bind of binds) {
    if (laneIds.has(bind.lane)) addEdge(bind.node, `lane:${bind.lane}`, 'binds');
    else issue('unresolved-edge', `Seat binding ${bind.node} names lane "${bind.lane}", which fleet.json does not declare.`, [bind.node]);
  }
  const repoIds = new Set(seed.nodes.filter((node) => node.kind === 'repo').map((node) => node.id));
  for (const hold of holdNodes) {
    const repoNode = `repo:${hold.repo}`;
    if (repoIds.has(repoNode)) addEdge(hold.id, repoNode, 'holds');
    else issue('unresolved-edge', `Hold ${hold.id} names repo "${hold.repo}", which fleet.json does not declare.`, [hold.id]);
  }

  seed.nodes.sort((a, b) => a.id.localeCompare(b.id));
  seed.edges.sort((a, b) => a.id.localeCompare(b.id));
  seed.sources.seats.count = seatSlice.length;
  seed.counts = {
    nodes: seed.nodes.length,
    edges: seed.edges.length,
    repos: seed.nodes.filter((node) => node.kind === 'repo').length,
    lanes: seed.nodes.filter((node) => node.kind === 'lane').length,
    seats: seed.nodes.filter((node) => node.kind === 'seat').length,
    holds: seed.nodes.filter((node) => node.kind === 'hold').length,
    rejected,
  };
  return seed;
}

// ---------------------------------------------------------------------------
// IO — guarded, never-throwing
// ---------------------------------------------------------------------------

/** `~/.ashlr/fleet/fleet.json` (ASHLR_HOME honored when absolute, like the fleet stores). */
export function fleetInventoryPath(home: string = homedir()): string {
  const configured = process.env['ASHLR_HOME'];
  const root = typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? resolve(configured)
    : join(home, '.ashlr');
  return join(root, 'fleet', 'fleet.json');
}

export type FleetInventoryRead =
  | { ok: true; path: string; inventory: unknown }
  | { ok: false; path: string; reason: 'missing' | 'unreadable' | 'too-large' | 'malformed' };

/** Read + parse fleet.json. Never throws; a bad file is a state, not an exception. */
export function readFleetInventory(path: string = fleetInventoryPath()): FleetInventoryRead {
  try {
    const raw = readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > FLEET_GRAPH_SEED_LIMITS.maxFileBytes) {
      return { ok: false, path, reason: 'too-large' };
    }
    return { ok: true, path, inventory: JSON.parse(raw) as unknown };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, path, reason: 'missing' };
    if (error instanceof SyntaxError) return { ok: false, path, reason: 'malformed' };
    return { ok: false, path, reason: 'unreadable' };
  }
}

export interface SeedFleetGraphOptions {
  /** fleet.json location; defaults to {@link fleetInventoryPath}. */
  fleetJsonPath?: string;
  /** Explicit seat rows — wins over `listSeats`. */
  seats?: readonly unknown[];
  /**
   * The phm seat inventory source. Default: `discoverSeats` (verse/seats.ts)
   * over a read-only config — its PUBLIC `seats` half only; `launches`
   * (launcher commands, the seats.ts privacy boundary) is never touched.
   */
  listSeats?: (cfg: AshlrConfig) => Promise<readonly unknown[]> | readonly unknown[];
  now?: () => Date;
}

/**
 * End-to-end seed: read fleet.json, pull the phm seat inventory, build the
 * graph.v1 document. Never throws — unreadable input degrades to a flagged
 * partial seed.
 */
export async function seedFleetGraph(options: SeedFleetGraphOptions = {}): Promise<FleetGraphSeedV1> {
  const path = options.fleetJsonPath ?? fleetInventoryPath();
  const read = readFleetInventory(path);

  let seats: readonly unknown[] | undefined = options.seats;
  if (seats === undefined) {
    const list = options.listSeats ?? (async (cfg: AshlrConfig) => {
      const { discoverSeats } = await import('../verse/seats.js');
      return (await discoverSeats(cfg)).seats;
    });
    try {
      const { loadConfigReadOnly } = await import('../config.js');
      seats = await list(loadConfigReadOnly());
    } catch {
      seats = undefined;
    }
  }

  const seed = buildFleetGraphSeed(
    { fleet: read.ok ? read.inventory : undefined, seats, fleetJsonPath: path },
    { now: options.now },
  );
  if (!read.ok) {
    // `missing` is the designed empty state; anything else is loud.
    const state = read.reason === 'missing' ? 'absent' : 'malformed';
    seed.sources.fleetJson = { state, path };
    if (read.reason !== 'missing') {
      seed.complete = false;
      if (seed.issues.length < FLEET_GRAPH_SEED_LIMITS.maxIssues) {
        seed.issues.push({
          code: 'malformed',
          message: `fleet.json could not be read (${read.reason}); only seat evidence was seeded.`,
          nodeIds: [],
        });
      }
    }
  }
  return seed;
}
