/**
 * Typed-routing observation journal recurring failures → self-improvement
 * backlog items.
 *
 * Every dispatcher tick that finds a tiered ready row, dispatchd's
 * observe_typed_route (contrib/mac/dispatchd.py) samples the typed routing
 * service once: it builds a minimal route request from the ready row and
 * the gate's admit verdict and calls `phm route decide` under a 0.9 s
 * bound, then appends one route.explain.v1 row to
 * <runsDir>/metrics/route.explain.jsonl — status 'observed' with the
 * validated decision (lane, model, effort, speed_tier, reason_codes) or
 * 'unavailable' when the call itself failed (missing CLI, timeout,
 * oversized or invalid output). Two evidence kinds in that journal never
 * became work:
 *
 *  - A service that keeps answering 'unavailable': the typed layer's only
 *    production observation path is dark — the phm binary missing or
 *    unrunnable at the daemon's path, route decide too slow for the tick
 *    budget, or output that keeps failing the envelope check. Until now
 *    the journal's only reader was `phm route explain`, a report someone
 *    had to run and read; a dark service looks identical to a healthy one
 *    until someone opens it.
 *  - Recurring degraded reason codes on observed picks: the typed layer
 *    answered but its model backends kept failing — schema-invalid and
 *    schema-retry (output failed the decision schema, the one allowed
 *    retry was consumed), backend-unavailable (every backend threw or
 *    models were disabled), deadline (the shared 450 ms service budget
 *    expired mid-pick) and deterministic-fallback (no backend produced an
 *    accepted pick, so deterministic candidate ranking chose). Until now
 *    those codes only ever reached the route.explain digest's top-eight
 *    tallies — counts with no recurrence fold and no path to work.
 *
 * routeExplainBacklogItems carries the same journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/route.explain.jsonl is read through readLedgerTail's
 *    bounded no-follow tail (the same 8 MiB bound readTypedDecisions gives
 *    this file); nothing is written and no network is touched.
 *  - Rows count only under the exact producer contract — the same
 *    typedDecisionSampleFrom validation the digest applies, so a row can
 *    never be valid evidence here and corrupt there. Malformed lines and
 *    contract violations are skipped, never guessed.
 *  - Recency-windowed. Only rows whose epoch-second ts lands inside
 *    TYPED_ROUTE_WINDOW_MS of the clock count, so a journal that stopped
 *    recording weeks ago never queues work for stale failures.
 *  - Recurring means recorded. The service item emits only when
 *    'unavailable' rows reach TYPED_ROUTE_UNAVAILABLE_RECURRING inside the
 *    window AND outnumber the window's 'observed' rows — the ci-rerun
 *    call-failure rule — so transient timeouts during a busy spell stay
 *    quiet while a dark service convicts. A reason-code item emits only at
 *    TYPED_ROUTE_REASON_RECURRING in-window rows carrying that code, and
 *    the prompt quotes the code's share of observed decisions so a rare
 *    code on a huge sample reads as the small count it is.
 *  - Healthy states never emit. 'no-candidates' and 'admission-blocked'
 *    describe a constrained fleet (every lane filtered, or the admission
 *    gate tripped) — recorded market/host state, not machinery failure —
 *    and 'single-candidate', 'mode-tier', the backend names and the
 *    capacity reasons are healthy picks. Only the five codes that mean a
 *    backend or the budget failed are tallied.
 *  - The journal is this install's dispatcher machinery — the fleet's own
 *    repository. Items therefore emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids hash the cell identity (the service
 *    cell, or one degraded code — never counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds only
 *    what is new; a code that recovers simply stops re-adding.
 *  - Every emitted prompt quotes only recorded counts and closed-vocabulary
 *    reason codes — no journal free text reaches a prompt — names the
 *    journal, `phm route explain`, the machinery modules and the usual
 *    no-change escape for evidence that no longer reproduces or is
 *    owner-domain (a deliberately disabled model backend, a protected
 *    gate).
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import {
  TYPED_DECISIONS_LEDGER_LIMIT,
  TYPED_DECISIONS_LEDGER_RELATIVE,
  typedDecisionSampleFrom,
} from '../router/typed-decisions.js';

/** Items one call may emit; the cell set is one service cell plus the five degraded codes. */
export const TYPED_ROUTE_MAX_ITEMS = 8;
const TYPED_ROUTE_ITEM_HARD_MAX = 25;
/**
 * 'unavailable' rows inside the window before the service counts as
 * recurring — and they must outnumber the window's observed rows, the
 * ci-rerun call-failure majority rule.
 */
export const TYPED_ROUTE_UNAVAILABLE_RECURRING = 3;
/** In-window observed rows carrying one degraded code before it counts as recurring. */
export const TYPED_ROUTE_REASON_RECURRING = 3;
/** Evidence window: the same 7 days every sibling source anchors on. */
export const TYPED_ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Future-skew allowance on journal timestamps, same convention the sibling folds apply. */
const TYPED_ROUTE_FUTURE_SKEW_MS = 60_000;
/** The fleet's own repository label: dispatcher evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog area naming the machinery the evidence describes. */
const AREA = 'typed-routing';

/**
 * The reason codes that mean a typed pick degraded: the model backends
 * failed schema validation or threw, the shared service budget expired, or
 * no backend produced an accepted pick at all. Each entry carries the
 * one-line mechanism the item prompt quotes. Codes describing input state
 * ('no-candidates', 'admission-blocked'), healthy deterministic paths
 * ('single-candidate', 'mode-tier' and its capacity reasons) and backend
 * names on success are deliberately absent — they are recorded state, not
 * machinery failure.
 */
const DEGRADED_REASONS: ReadonlyMap<string, string> = new Map([
  ['schema-invalid', 'model backend output failed the route decision schema'],
  ['schema-retry', 'the single allowed schema retry was consumed after an invalid first pick'],
  ['backend-unavailable', 'every model backend was unavailable — calls threw or model routing is disabled'],
  ['deadline', 'the shared 450 ms service budget expired before a backend produced an accepted pick'],
  ['deterministic-fallback', 'no backend produced an accepted pick, so deterministic candidate ranking chose instead'],
]);

export interface RouteExplainItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Fleet runs dir holding metrics/route.explain.jsonl; $ASHLR_RUNS_DIR wins when set, else ~/.ashlr-runs. */
  runsDir?: string;
  /** Journal override (default: <runsDir>/metrics/route.explain.jsonl). */
  ledgerPath?: string;
  /** Most items one call emits (default TYPED_ROUTE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the evidence window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const NO_CHANGE = 'If the window has rolled forward, the fleet was simply saturated or held (a deliberate lane hold, an admission-gate trip, exhausted quota), model routing was deliberately disabled, or the cause is owner-only — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is metrics/route.explain.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), written once per dispatcher tick by observe_typed_route in contrib/mac/dispatchd.py — each row a bounded advisory sample of `phm route decide`. `phm route explain --json` folds the same journal into its typed_decisions digest (records, observed/unavailable counts, lane/model/reason-code tallies, latency and attempt summaries); the decision service itself is src/core/routing/decision.ts over decision-backends.ts and decision-candidates.ts, and the row contract lives in src/core/router/typed-decisions.ts.';

function servicePrompt(unavailable: number, observed: number, records: number): string {
  return [
    `Phantom's typed routing service keeps failing the dispatcher's per-tick sample — the route.explain journal recorded ${unavailable} 'unavailable' rows against ${observed} observed picks inside the window.`,
    '',
    `Every dispatcher tick that finds a tiered ready row calls \`phm route decide\` under a 0.9 s bound and journals the outcome. 'unavailable' means the call itself failed: the phm binary missing or unrunnable at the daemon's path, the service exceeding the sample budget, or output that keeps failing the route.decision.v1 envelope check. ${records} valid journal rows were recorded inside the ${Math.round(TYPED_ROUTE_WINDOW_MS / 86_400_000)}-day window.`,
    '',
    EVIDENCE,
    '',
    `Find why the service call fails: whether \`phm route decide --input - --root <runs> --json\` runs cleanly by hand on this host (missing binary, broken install, Node version), whether the 450 ms service budget plus CLI startup fits the 0.9 s sample bound under host load, and whether the service emits schema-valid route.decision.v1 output. If recent samples succeed — the window rolled forward past a transient outage — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function reasonPrompt(code: string, count: number, observed: number, records: number): string {
  const mechanism = DEGRADED_REASONS.get(code) ?? code;
  const share = observed > 0 ? Math.round((count / observed) * 1000) / 10 : null;
  const shareText = share === null ? '' : ` — ${share}% of the window's ${observed} observed decisions`;
  return [
    `Phantom's typed routing picks keep degrading: '${code}' appeared on ${count} of the window's observed route decisions (${mechanism})${shareText}.`,
    '',
    `${records} valid route.explain.v1 rows were recorded inside the ${Math.round(TYPED_ROUTE_WINDOW_MS / 86_400_000)}-day window; ${observed} carried a validated decision and ${count} of those decisions carried the '${code}' reason code at least once.`,
    '',
    EVIDENCE,
    '',
    `Find which side is degraded: for 'schema-invalid'/'schema-retry' check the model backends' decision-schema conformance in decision-backends.ts; for 'backend-unavailable' check routeModelsDisabled, backend reachability and credentials custody (names only, never values); for 'deadline' check whether the 450 ms shared budget or host load starves the backends; for 'deterministic-fallback' determine which upstream code kept firing. If the code no longer recurs — recent decisions pick cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function serviceItem(unavailable: number, observed: number, records: number, repo: string): CloudBacklogItem {
  const id = `route-explain-service-${createHash('sha256').update('typed-route:service-unavailable').digest('hex').slice(0, 16)}`;
  return {
    id,
    title: 'Typed route service keeps failing dispatcher samples'.slice(0, MAX_TITLE_CHARS),
    prompt: servicePrompt(unavailable, observed, records),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function reasonItem(code: string, count: number, observed: number, records: number, repo: string): CloudBacklogItem {
  const id = `route-explain-reason-${code}-${createHash('sha256').update(`typed-route:reason:${code}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `Typed route picks keep degrading to '${code}'`.slice(0, MAX_TITLE_CHARS),
    prompt: reasonPrompt(code, count, observed, records),
    area: AREA,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the typed-routing journal's recurring unavailable
 * samples and degraded reason codes. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function routeExplainBacklogItems(opts: RouteExplainItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (!CLOUD_REPO_PATTERN.test(repo) || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowStartMs = nowMs - TYPED_ROUTE_WINDOW_MS;
    const windowEndMs = nowMs + TYPED_ROUTE_FUTURE_SKEW_MS;
    // Same runs-dir resolution readTypedDecisions applies: explicit
    // override, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(homedir(), '.ashlr-runs'));
    const ledgerPath = opts.ledgerPath ?? join(runsDir, TYPED_DECISIONS_LEDGER_RELATIVE);
    const read = await readLedgerTail(ledgerPath, TYPED_DECISIONS_LEDGER_LIMIT);
    if (read.state !== 'read') return [];

    let records = 0;
    let observed = 0;
    let unavailable = 0;
    const reasonCounts = new Map<string, number>();
    for (const line of read.text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let row: unknown;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const sample = typedDecisionSampleFrom(row);
      if (sample === null) continue;
      // Journal ts is epoch seconds; the window anchors on milliseconds.
      const tsMs = sample.ts * 1000;
      if (!Number.isFinite(tsMs) || tsMs < windowStartMs || tsMs > windowEndMs) continue;
      records += 1;
      if (sample.status === 'unavailable') {
        unavailable += 1;
        continue;
      }
      observed += 1;
      const codes = new Set(sample.decision!.reason_codes);
      for (const code of codes) {
        if (DEGRADED_REASONS.has(code)) reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
      }
    }
    if (records === 0) return [];

    const candidates: CloudBacklogItem[] = [];
    // The service cell gates first so it survives limit truncation, mirroring
    // the ci-rerun call item ahead of its verdict groups.
    if (unavailable >= TYPED_ROUTE_UNAVAILABLE_RECURRING && unavailable > observed) {
      candidates.push(serviceItem(unavailable, observed, records, repo));
    }
    const recurring = [...reasonCounts.entries()]
      .filter(([, count]) => count >= TYPED_ROUTE_REASON_RECURRING)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [code, count] of recurring) candidates.push(reasonItem(code, count, observed, records, repo));

    const limit = Math.max(1, Math.min(opts.limit ?? TYPED_ROUTE_MAX_ITEMS, TYPED_ROUTE_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
