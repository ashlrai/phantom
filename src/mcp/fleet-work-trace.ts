/**
 * `fleet_work_trace` MCP adapter: the single work-item state read —
 * `collectBusWorkItemEvidence` + `classifyWorkItem`, the same composition
 * `phm fleet work-trace --id <id>` and GET
 * /api/verse/fleet/control/work-trace?id=<id> serve. `fleet_work_board`
 * lists the recent durable bus requests classified the same way but only
 * inside its newest-first page, `fleet_agent_work`'s workBoard section
 * narrows that listing to one agent's labels and `fleet_work_feed`'s `id`
 * filter keeps whole jobs citing the wire id — none answers "what state
 * does the durable evidence support for THIS bus message id" in one
 * call: the deep read a board row, a feed citation or a `work-trace`
 * link resolves to, carrying the claim-receipt citation, owner, the
 * per-source read states (inbox/claims/coordination) and the BLOCKED
 * dependency or VERIFIED proof fields the classifier attaches.
 *
 * `id` is required and takes the same bound the HTTP route applies —
 * non-blank, at most WORK_TRACE_MAX_ID_LENGTH chars, no NUL — validated
 * before any store read; unknown keys, caller roots, paths and working
 * directories are refused the same way. Read-only: the fleet root stays
 * server-owned (`join(ashlrHome(), 'fleet')`, the same root
 * `fleet_work_board` reads) and the tool never claims, acks, posts,
 * renews TTL or dispatches. State is evidence only — RECEIVED /
 * ASSIGNED / RUNNING / BLOCKED / VERIFIED with asOf, source and the
 * missing-evidence list — and grants no dispatch, claim or merge
 * authority; routing labels are data, never authenticated identity. An
 * evidence read that cannot complete degrades to the same honest unknown
 * item the API reports per id — never an invented state.
 */
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import {
  collectBusWorkItemEvidence, type BusWorkItemEvidenceResult,
  type BusWorkItemSources,
} from '../core/comms/work-item-bus-evidence.js';
import { classifyWorkItem, type WorkItemState } from '../core/comms/work-item-state.js';
import { scrubSecrets } from '../core/util/scrub.js';
import { WORK_TRACE_MAX_ID_LENGTH } from '../core/verse/fleet-work-trace-api.js';

const WORK_TRACE_KEYS = new Set(['id']);

export interface FleetWorkTraceArgs {
  /** Bus message id whose durable evidence is classified. */
  id: string;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `id` is
 * required — the trace has no meaningful default — and takes the same
 * bound GET /api/verse/fleet/control/work-trace applies: non-blank after
 * trim, at most WORK_TRACE_MAX_ID_LENGTH chars, no NUL. Unknown keys,
 * wrong types, caller roots and malformed values are all refused before
 * the store is touched.
 */
export function parseFleetWorkTraceArgs(args: Record<string, unknown>): FleetWorkTraceArgs | null {
  if (Object.keys(args).some(key => !WORK_TRACE_KEYS.has(key))) return null;
  const id = args.id;
  if (typeof id !== 'string' || !id.trim() || id.length > WORK_TRACE_MAX_ID_LENGTH || id.includes('\0')) return null;
  return { id };
}

export interface FleetWorkTraceDeps {
  collect?: typeof collectBusWorkItemEvidence;
  now?: () => number;
}

interface FleetWorkTraceMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The proof block a BLOCKED or VERIFIED classification carries — the
 * same `result` field the CLI's --json and the API's items report. */
type FleetWorkTraceProof =
  | { kind: 'blocked'; dependency: string }
  | { kind: 'verified'; pr: number | null; head: string | null; tests: string | null; artifact: string | null };

/** One traced item: the classifier's verdict plus the evidence owner,
 * claim-receipt citation, per-source read states and optional proof —
 * the same fields the CLI and API compose for one id. */
export interface FleetWorkTraceItem {
  id: string;
  state: WorkItemState;
  asOf: string;
  source: string;
  missing: string[];
  owner: string | null;
  claimReceipt: string | null;
  inbox: BusWorkItemSources['inbox'];
  claims: BusWorkItemSources['claims'];
  coordination: BusWorkItemSources['coordination'];
  result?: FleetWorkTraceProof;
}

/** The traced item with the MCP envelope metadata on it. */
export type FleetWorkTraceResult = FleetWorkTraceMeta & FleetWorkTraceItem;

/** The per-item composition `phm fleet work-trace` and the work-trace API
 * share: classify the collected evidence, scrub proof fields, attach the
 * BLOCKED dependency or VERIFIED pr/head/tests/artifact proof. */
function traceItem(id: string, collected: BusWorkItemEvidenceResult, nowIso: string): FleetWorkTraceItem {
  const { evidence, sources } = collected;
  const classified = classifyWorkItem(evidence, nowIso);
  const safe = (value: string): string => scrubSecrets(value).replace(/[\r\n\p{Cc}\p{Zl}\p{Zp}]/gu, ' ');
  const field = (value: string | undefined): string | null => value === undefined ? null : safe(value.slice(0, 200));
  const proof: FleetWorkTraceProof | undefined = classified.state === 'BLOCKED' && evidence.blocker
    ? { kind: 'blocked', dependency: safe(evidence.blocker.dependency) }
    : classified.state === 'VERIFIED' && evidence.verified
      ? { kind: 'verified', pr: evidence.verified.pr ?? null, head: field(evidence.verified.head),
        tests: field(evidence.verified.tests), artifact: field(evidence.verified.artifact) }
      : undefined;
  return { id, ...classified, ...(proof ? { result: proof } : {}), owner: evidence.owner ?? null,
    claimReceipt: evidence.claimReceipt ?? null, inbox: sources.inbox, claims: sources.claims,
    coordination: sources.coordination };
}

/**
 * One work-item trace through the shared `collectBusWorkItemEvidence` +
 * `classifyWorkItem` projection — the identical read `phm fleet
 * work-trace --id` and the work-trace API run, so evidence collection,
 * the freshness/skew rules and the missing-evidence honesty fields can
 * never diverge between surfaces. The fleet root stays server-owned
 * (`join(ashlrHome(), 'fleet')`); a collect or classify failure degrades
 * to the same unknown item the API reports per id — RECEIVED with
 * as-of/source unknown and every source unavailable — never an invented
 * state or a thrown store error.
 */
export async function readFleetWorkTrace(
  args: FleetWorkTraceArgs,
  deps: FleetWorkTraceDeps = {},
): Promise<FleetWorkTraceResult> {
  const now = (deps.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const collect = deps.collect ?? collectBusWorkItemEvidence;
  let item: FleetWorkTraceItem;
  try {
    item = traceItem(args.id, collect(args.id, { root: join(ashlrHome(), 'fleet'), now }), nowIso);
  } catch {
    // Same degraded shape the API reports per id when evidence cannot be
    // read; never send the thrown message — it may carry store paths.
    item = { id: args.id, state: 'RECEIVED', asOf: 'unknown', source: 'none',
      missing: ['work-item evidence'], owner: null, claimReceipt: null,
      inbox: 'unavailable', claims: 'unavailable', coordination: 'unavailable' };
  }
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: nowIso,
    ...item,
  };
}
