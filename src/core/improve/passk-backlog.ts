/**
 * pass^k eval regression alerts → self-improvement backlog items.
 *
 * The nightly pass^k eval (`phm eval passk schedule`) publishes each run's
 * report under ~/.ashlr/eval/passk/ and appends every derived regression
 * alert — a lane/model that lost a golden task (task-regressed), whose mean
 * pass^k fell past the alert floor (passk-drop), or whose per-dimension rate
 * dropped (dimension-drop) — to alerts.jsonl. Until now the only reader was
 * `phm eval passk alerts`, a report someone had to run and read, so a lane
 * that kept losing measured capability never became work. The lane-scores
 * projection already feeds router weights, but the alerts journal — the
 * regression events themselves — reached nothing.
 * passkAlertBacklogItems carries the still-evidenced regressions into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the fleet outcome-learning, nightly
 * retro, policy and local-gate sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through loadPassKAlerts' bounded parse
 *    and the newest report through loadLatestPassKReport's latest.json
 *    pointer; nothing is written and no network is touched.
 *  - Healthy-only evidence. A missing journal or any dropped row marks the
 *    read degraded and yields no items — the same bar the sibling sources
 *    apply, so unknown stays unknown rather than becoming a guessed tally.
 *  - Recency-windowed. An identity emits only when its newest alert lands
 *    inside PASSK_ALERT_WINDOW_MS of the clock, so a stale journal on a
 *    fleet whose eval stopped running never queues work.
 *  - Two evidence paths, both recorded. An alert identity emits when EITHER
 *    the journal shows it on at least PASSK_ALERT_MIN_REPORTS distinct eval
 *    reports (recurring across runs — the transition-style alerts fire once
 *    per break, so repetition means flapping or continued decay), OR the
 *    newest persisted report still shows the regression the alert recorded
 *    (a one-shot break that never healed). The second path is what makes a
 *    single persistent regression visible without letting a one-night
 *    infrastructure blip that already recovered queue a session.
 *  - The eval machinery is this repository's: lanes, models, the golden set
 *    and the harness live here. Items therefore emit only when the backlog
 *    target's repository name is 'phantom', the same last-segment rule
 *    fleetPolicyBacklogItems and localGateBacklogItems apply; self-
 *    improvement pointed at another repository never inherits this fleet's
 *    capability-regression evidence it cannot attribute.
 *  - Dedup is downstream. The item id embeds a stable hash of the alert
 *    identity (kind + lane + model + task + dimension, never the counts,
 *    rates or timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a regression that heals
 *    simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: alert kinds, lanes,
 *    models, task ids and dimensions are scrubbed and flattened to one line
 *    before they reach the prompt, rates are quoted only as recorded, the
 *    corroboration state (still regressed / recovered / unverifiable) is
 *    stated explicitly, and the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  loadLatestPassKReport,
  loadPassKAlerts,
  PASSK_ALERT_MIN_DROP,
  type PassKAlert,
  type PassKAlertLine,
  type PassKReport,
  type PassKStoreOptions,
} from '../eval/passk.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; alert identities are bounded upstream but unbounded in practice. */
export const PASSK_ALERT_MAX_ITEMS = 8;
const PASSK_ALERT_ITEM_HARD_MAX = 25;
/** Distinct eval reports an alert identity needs before recurrence alone emits it. */
export const PASSK_ALERT_MIN_REPORTS = 2;
/** Alert evidence older than this never emits; nightly cadence makes a month generous. */
export const PASSK_ALERT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded identity fields are unbounded; flatten and cap before they reach a prompt. */
const MAX_FIELD_CHARS = 96;
/** The fleet's own repository label: eval evidence is this repo's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Float slack when re-checking a recorded rate against the alert floor. */
const RATE_EPS = 1e-9;
const ALERT_KINDS: ReadonlySet<string> = new Set(['task-regressed', 'passk-drop', 'dimension-drop']);
const DIMENSIONS: ReadonlySet<string> = new Set(['tests', 'diffQuality', 'instructions']);

export interface PasskAlertItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** ASHLR root override for the eval store (PassKStoreOptions semantics; default: ASHLR_HOME or ~/.ashlr). */
  rootDir?: string;
  /** Recency window for alert evidence in ms (default PASSK_ALERT_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default PASSK_ALERT_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock for the recency window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded fields are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** A journal line normalized to the fields the fold consumes, or null when it is not one. */
interface AlertRow {
  ts: string;
  report: string;
  ms: number;
  alert: PassKAlert;
}

function alertRow(line: PassKAlertLine): AlertRow | null {
  const a = line.alert;
  if (a === null || typeof a !== 'object' || !ALERT_KINDS.has(a.kind)) return null;
  if (typeof a.lane !== 'string' || a.lane.trim() === ''
    || typeof a.model !== 'string' || a.model.trim() === '') return null;
  if (!Number.isFinite(a.before) || !Number.isFinite(a.after)) return null;
  const taskId = typeof a.taskId === 'string' && a.taskId.trim() !== '' ? a.taskId : undefined;
  const dimension = typeof a.dimension === 'string' && DIMENSIONS.has(a.dimension)
    ? a.dimension as PassKAlert['dimension']
    : undefined;
  // The task-scoped kinds are meaningless without their task; a dimension-drop
  // without its dimension cannot be re-checked against the latest report.
  if ((a.kind === 'task-regressed' || a.kind === 'dimension-drop') && taskId === undefined) return null;
  if (a.kind === 'dimension-drop' && dimension === undefined) return null;
  return {
    ts: line.ts,
    report: line.report,
    ms: Date.parse(line.ts),
    alert: {
      kind: a.kind as PassKAlert['kind'],
      lane: a.lane,
      model: a.model,
      ...(taskId === undefined ? {} : { taskId }),
      ...(dimension === undefined ? {} : { dimension }),
      before: a.before,
      after: a.after,
    },
  };
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Whether the newest persisted report still shows the regression the alert
 * recorded — a tri-state because "cannot measure" is not "cleared":
 *  - 'still': the report measured the quantity and it remains beyond the
 *    alert floor (passk-drop and dimension-drop compare against the
 *    recorded `before` minus PASSK_ALERT_MIN_DROP; task-regressed asks for
 *    zero passes again);
 *  - 'cleared': the report measured the quantity and it recovered;
 *  - 'unverifiable': no report, or the report cannot measure this identity
 *    (missing lane, task, rate or field) — unknown stays unknown and the
 *    recurrence path alone may still emit.
 */
function reportCorroboration(alert: PassKAlert, report: PassKReport | undefined): 'still' | 'cleared' | 'unverifiable' {
  if (report === undefined) return 'unverifiable';
  const lanes = Array.isArray(report.lanes) ? report.lanes : [];
  const lane = lanes.find((l) => l !== null && typeof l === 'object' && l.lane === alert.lane && l.model === alert.model);
  if (lane === undefined) return 'unverifiable';
  if (alert.kind === 'passk-drop') {
    const v = finiteOrNull(lane.meanPassPowK);
    if (v === null) return 'unverifiable';
    return v <= alert.before - PASSK_ALERT_MIN_DROP + RATE_EPS ? 'still' : 'cleared';
  }
  const taskId = alert.taskId;
  if (taskId === undefined) return 'unverifiable';
  const tasks = Array.isArray(lane.tasks) ? lane.tasks : [];
  const task = tasks.find((t) => t !== null && typeof t === 'object' && t.taskId === taskId);
  if (task === undefined) return 'unverifiable';
  if (alert.kind === 'task-regressed') {
    if (typeof task.passes !== 'number' || !Number.isFinite(task.passes)) return 'unverifiable';
    return task.passes === 0 ? 'still' : 'cleared';
  }
  const dim = alert.dimension;
  if (dim === undefined) return 'unverifiable';
  const rates = task.dimensionRates;
  const v = rates !== null && typeof rates === 'object' ? finiteOrNull((rates as Record<string, unknown>)[dim]) : null;
  if (v === null) return 'unverifiable';
  return v <= alert.before - PASSK_ALERT_MIN_DROP + RATE_EPS ? 'still' : 'cleared';
}

interface AlertCandidate {
  /** Stable JSON tuple of the alert identity — the dedup hash input, never counts or timestamps. */
  identity: string;
  /** The newest alert row's normalized alert (its before/after are the latest recorded rates). */
  alert: PassKAlert;
  /** Newest alert timestamp as written (ISO text for the prompt). */
  ts: string;
  /** Newest alert's report id. */
  report: string;
  /** Distinct eval reports that flagged this identity inside the journal window. */
  reports: number;
  /** Total alert rows recorded for this identity. */
  rows: number;
  newestMs: number;
  /** Latest-report corroboration: still measured, measured-clear, or unverifiable (no report). */
  corroboration: 'still' | 'cleared' | 'unverifiable';
}

/** Kind-specific evidence clause quoted into the prompt, rates as recorded. */
function candidateDetail(c: AlertCandidate): string {
  const lane = fieldText(c.alert.lane);
  const model = fieldText(c.alert.model);
  const pair = `${lane}/${model}`;
  if (c.alert.kind === 'task-regressed') {
    const task = fieldText(c.alert.taskId ?? '');
    return `task '${task}' on ${pair} passed in an earlier eval report and recorded zero passes — pass@1 ${pct(c.alert.before)} → ${pct(c.alert.after)}`;
  }
  if (c.alert.kind === 'passk-drop') {
    return `mean pass^k on ${pair} fell ${pct(c.alert.before)} → ${pct(c.alert.after)}`;
  }
  const task = fieldText(c.alert.taskId ?? '');
  const dim = c.alert.dimension ?? '';
  return `${dim} rate on task '${task}' for ${pair} fell ${pct(c.alert.before)} → ${pct(c.alert.after)}`;
}

function alertTitle(c: AlertCandidate): string {
  const lane = fieldText(c.alert.lane, 48);
  const model = fieldText(c.alert.model, 48);
  const pair = `${lane}/${model}`;
  const task = fieldText(c.alert.taskId ?? '', 64);
  if (c.alert.kind === 'task-regressed') return `Pass^k eval: ${pair} lost task '${task}'`;
  if (c.alert.kind === 'passk-drop') return `Pass^k eval: ${pair} pass^k dropped ${pct(c.alert.before)} → ${pct(c.alert.after)}`;
  return `Pass^k eval: ${pair} ${c.alert.dimension ?? ''} dropped on '${task}'`;
}

function passkAlertItem(c: AlertCandidate, repo: string): CloudBacklogItem {
  const id = `passk-alert-${createHash('sha256').update(c.identity).digest('hex').slice(0, 16)}`;
  const lane = fieldText(c.alert.lane);
  const model = fieldText(c.alert.model);
  const corroboration = c.corroboration === 'still'
    ? 'The newest persisted eval report still shows this regression.'
    : c.corroboration === 'cleared'
      ? 'The newest persisted eval report no longer shows this regression — the item rests on the recorded recurrence across eval reports.'
      : 'No persisted eval report could corroborate this identity — the item rests on the recorded recurrence across eval reports.';
  const prompt = [
    `Phantom's pass^k eval journal recorded a ${c.alert.kind} regression for lane '${lane}' (model '${model}') — the self-improvement work this backlog exists for.`,
    '',
    `${candidateDetail(c)}.`,
    `Evidence: ${c.rows} alert row(s) across ${c.reports} distinct eval report(s) in the journal; newest ${fieldText(c.ts, 64)} (report '${fieldText(c.report, 96)}'). ${corroboration}`,
    '',
    'The alerts journal is eval/passk/alerts.jsonl and each report eval/passk/reports/<id>.json under the Phantom state directory (~/.ashlr or $ASHLR_HOME); `phm eval passk alerts --json` and `phm eval passk scores --json` read the same store. Find what changed for this lane/model — a routing or prompt-template change, a model or harness update, or eval-infrastructure noise — reproduce with `phm eval passk`, and fix the cause in this repository. If the newest eval report no longer shows the regression, report no-change and name the evidence.',
  ].join('\n');
  return {
    id,
    title: alertTitle(c).slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'passk-eval',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the pass^k eval journal's evidenced regressions,
 * currently-regressed first then strongest recurrence. Total: any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function passkAlertBacklogItems(opts: PasskAlertItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const store: PassKStoreOptions = opts.rootDir === undefined ? {} : { rootDir: opts.rootDir };
    const journal = loadPassKAlerts(store);
    // Healthy-only evidence bar: a missing or partially corrupt journal is
    // unknown, never a guessed regression tally — the same rule the sibling
    // sources apply to their own degraded corpora.
    if (journal.state !== 'healthy') return [];
    const latestReport = loadLatestPassKReport(store);
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? PASSK_ALERT_WINDOW_MS;

    const groups = new Map<string, AlertRow[]>();
    for (const line of journal.alerts) {
      const row = alertRow(line);
      if (row === null) continue;
      const a = row.alert;
      const identity = JSON.stringify([a.kind, a.lane, a.model, a.taskId ?? null, a.dimension ?? null]);
      const rows = groups.get(identity);
      if (rows === undefined) groups.set(identity, [row]);
      else rows.push(row);
    }

    const candidates: AlertCandidate[] = [];
    for (const [identity, rows] of groups) {
      const reports = new Set<string>();
      let newestMs = -Infinity;
      let newest: AlertRow | null = null;
      for (const row of rows) {
        reports.add(row.report);
        if (Number.isFinite(row.ms) && row.ms > newestMs) {
          newestMs = row.ms;
          newest = row;
        }
      }
      // No parseable timestamp means recency is unverifiable — unknown stays unknown.
      if (newest === null) continue;
      if (nowMs - newestMs > windowMs) continue;
      const corroboration = reportCorroboration(newest.alert, latestReport);
      if (reports.size < PASSK_ALERT_MIN_REPORTS && corroboration !== 'still') continue;
      candidates.push({
        identity,
        alert: newest.alert,
        ts: newest.ts,
        report: newest.report,
        reports: reports.size,
        rows: rows.length,
        newestMs,
        corroboration,
      });
    }

    // Currently-measured regressions outrank historical recurrence; within
    // each band the strongest recorded evidence (most distinct reports,
    // then most recent) wins, identity last so the order is total.
    candidates.sort((a, b) =>
      Number(b.corroboration === 'still') - Number(a.corroboration === 'still')
      || b.reports - a.reports
      || b.newestMs - a.newestMs
      || a.identity.localeCompare(b.identity));

    const limit = Math.max(1, Math.min(opts.limit ?? PASSK_ALERT_MAX_ITEMS, PASSK_ALERT_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => passkAlertItem(c, repo));
  } catch {
    return [];
  }
}
