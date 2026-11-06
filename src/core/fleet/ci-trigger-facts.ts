/**
 * Facts behind `ashlr fleet ci-triggers` — the read-only workflow-trigger
 * inventory for Mason's Nov 1 order: stop per-PR/push CI, run CI once daily.
 * No GitHub calls live here: the CLI injects a CiTriggerReader. A failed read
 * or unparseable workflow yields `unknown`/unread rows — never a fake clean
 * inventory. Only `ci-test` rows are ever flagged, so release/custody/
 * publishing work is never proposed for disabling.
 */
import { parseDocument } from 'yaml';

export type CiTriggerClassification = 'ci-test' | 'release-deployment' | 'maintenance' | 'unknown';

/** Declared `on:` shape, normalised across all YAML forms. */
export interface CiTriggerEvents {
  events: string[];           // every event name, declaration order, deduped
  schedules: string[];        // `schedule` cron entries, declaration order
  manualOrReusable: string[]; // workflow_dispatch / workflow_call — never daily runs
}

/** One inventory row as the reader fetched it (the source read may have failed). */
export interface CiTriggerWorkflowItem {
  path: string;
  name: string | null;
  enabled: boolean | null; // API `state === 'active'`; null when not reported
  source: { ok: true; text: string } | { ok: false; reason: string };
}

export type CiTriggerRepoRead =
  | { ok: true; defaultBranch: string; defaultBranchSha: string; truncated: string[]; workflows: CiTriggerWorkflowItem[] }
  | { ok: false; reason: string };

/** Injected per-repo read; the production implementation is ghCiTriggerReader. */
export type CiTriggerReader = (repo: string) => Promise<CiTriggerRepoRead>;

export interface CiTriggerWorkflowRow extends CiTriggerEvents {
  path: string;
  name: string | null;
  enabled: boolean | null;
  classification: CiTriggerClassification;
  dailySchedules: string[]; // cron entries shaped `M H * * *`
  flags: string[];
  /** ci-test + not disabled + flags → the Nov 1 order needs owner edits. */
  ownerReview: boolean;
  read: 'ok' | 'unread' | 'unparsed';
  error: string | null;
}

export interface CiTriggerFactsReport {
  v: 1;
  generatedAt: string;
  repo: string;
  status: 'ok' | 'unknown';
  reason: string | null;
  defaultBranch: string | null;
  defaultBranchSha: string | null;
  scanned: number;
  unread: number;
  truncated: string[];
  ownerReview: { path: string; name: string | null; flags: string[] }[];
  workflows: CiTriggerWorkflowRow[];
  caveats: string[];
}

export const CI_TRIGGER_CAVEATS = Object.freeze([
  'Static cron declarations do not prove actual once-per-day execution.',
  'Reusable/manual events (workflow_call, workflow_dispatch) are not daily scheduled runs.',
  'Owner-review rows name trigger facts; workflow and required-check edits remain owner actions.',
]);

const EVENT_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,60}$/;
const MAX_EVENTS = 64, MAX_SCHEDULES = 16, MAX_SOURCE_BYTES = 512 * 1024;

/** Parse declared triggers. Unparseable or unsupported input fails, never guesses. */
export function parseWorkflowTriggers(source: string): { ok: true; triggers: CiTriggerEvents } | { ok: false; reason: string } {
  if (source.length > MAX_SOURCE_BYTES) return { ok: false, reason: 'workflow source exceeds bound' };
  const doc = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0 || doc.warnings.length > 0) return { ok: false, reason: 'invalid or unsupported YAML' };
  const root = doc.toJS({ maxAliasCount: 100 }) as unknown;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { ok: false, reason: 'workflow YAML is not a mapping' };
  const record = root as Record<string, unknown>;
  // `on` stays a string key under the YAML 1.2 core schema; a YAML-1.1-processed
  // file surfaces it as the boolean-derived key 'true'. Honour both.
  const on = Object.hasOwn(record, 'on') ? record['on'] : record['true'];
  if (on === undefined || on === null) return { ok: true, triggers: { events: [], schedules: [], manualOrReusable: [] } };
  const events: string[] = [], schedules: string[] = [];
  const event = (value: unknown): string | null => {
    if (typeof value !== 'string' || !EVENT_NAME.test(value) || events.length >= MAX_EVENTS) return 'unsupported trigger event';
    if (!events.includes(value)) events.push(value);
    return null;
  };
  if (typeof on === 'string' || Array.isArray(on)) {
    for (const v of Array.isArray(on) ? on : [on]) {
      const bad = event(v);
      if (bad) return { ok: false, reason: bad };
    }
  } else if (typeof on === 'object') {
    for (const [key, value] of Object.entries(on)) {
      const bad = event(key);
      if (bad) return { ok: false, reason: bad };
      if (key !== 'schedule') continue;
      if (!Array.isArray(value) || value.length > MAX_SCHEDULES) return { ok: false, reason: 'unsupported schedule declaration' };
      for (const entry of value) {
        const cron = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['cron'] : undefined;
        if (typeof cron !== 'string' || cron.length > 100) return { ok: false, reason: 'unsupported schedule entry' };
        schedules.push(cron);
      }
    }
  } else return { ok: false, reason: 'unsupported on: form' };
  return { ok: true, triggers: { events, schedules, manualOrReusable: events.filter(e => e === 'workflow_dispatch' || e === 'workflow_call') } };
}

/** Fixed minute+hour with wildcard day/month fields — the once-a-day shape only. */
export const isDailyCron = (cron: string): boolean => /^\d{1,2} \d{1,2} \* \* \*$/.test(cron.trim().replace(/\s+/g, ' '));

// release/custody/publishing evidence first: those classes are never flagged.
const RELEASE = new Set(['release', 'publish', 'promote', 'promotion', 'admit', 'attest', 'attestation', 'finalize', 'deploy', 'registry', 'custody', 'tag']);
const CI = new Set(['ci', 'test', 'tests', 'smoke', 'check', 'checks', 'verify', 'gate', 'build', 'qualify', 'suite']);
const MAINT = new Set(['audit', 'stats', 'reaper', 'stale', 'cleanup', 'topology', 'observation', 'dependabot', 'sync']);

/** Token evidence from the display name and file path; ambiguous stays `unknown`. */
export function classifyWorkflow(name: string | null, path: string): CiTriggerClassification {
  const tokens = `${name ?? ''} ${path}`.toLowerCase().split(/[^a-z0-9]+/);
  if (tokens.some(t => RELEASE.has(t))) return 'release-deployment';
  if (tokens.some(t => CI.has(t))) return 'ci-test';
  if (tokens.some(t => MAINT.has(t))) return 'maintenance';
  return 'unknown';
}

const PER_CHANGE: Record<string, string> = {
  pull_request: 'pull-request-trigger', pull_request_target: 'pull-request-target-trigger',
  push: 'push-trigger', merge_group: 'merge-group-trigger',
};

/** One fetched workflow item → one report row. Source text never reaches the row. */
export function workflowTriggerRow(item: CiTriggerWorkflowItem): CiTriggerWorkflowRow {
  const base = {
    path: item.path, name: item.name, enabled: item.enabled,
    classification: classifyWorkflow(item.name, item.path),
    events: [] as string[], schedules: [] as string[], dailySchedules: [] as string[],
    manualOrReusable: [] as string[], flags: [] as string[], ownerReview: false,
  };
  if (!item.source.ok) return { ...base, read: 'unread' as const, error: item.source.reason };
  const parsed = parseWorkflowTriggers(item.source.text);
  if (!parsed.ok) return { ...base, read: 'unparsed' as const, error: parsed.reason };
  const { events, schedules, manualOrReusable } = parsed.triggers;
  const dailySchedules = schedules.filter(isDailyCron);
  const flags = events.flatMap(e => PER_CHANGE[e] ?? []);
  if (dailySchedules.length === 0) flags.push('no-daily-schedule');
  if (dailySchedules.length > 1) flags.push('multiple-daily-schedules');
  const ownerReview = base.classification === 'ci-test' && item.enabled !== false && flags.length > 0;
  return { ...base, events, schedules, dailySchedules, manualOrReusable, flags, ownerReview, read: 'ok' as const, error: null };
}

export function buildCiTriggerFacts(repo: string, read: CiTriggerRepoRead, now: Date): CiTriggerFactsReport {
  const base = {
    v: 1 as const, generatedAt: now.toISOString(), repo, reason: null as string | null,
    defaultBranch: null as string | null, defaultBranchSha: null as string | null,
    scanned: 0, unread: 0, truncated: [] as string[],
    ownerReview: [] as CiTriggerFactsReport['ownerReview'], workflows: [] as CiTriggerWorkflowRow[],
    caveats: [...CI_TRIGGER_CAVEATS],
  };
  if (!read.ok) return { ...base, status: 'unknown' as const, reason: read.reason };
  const workflows = read.workflows.map(workflowTriggerRow).sort((a, b) => a.path.localeCompare(b.path));
  return {
    ...base, status: 'ok' as const,
    defaultBranch: read.defaultBranch, defaultBranchSha: read.defaultBranchSha, truncated: read.truncated,
    scanned: workflows.filter(w => w.read === 'ok').length, unread: workflows.filter(w => w.read !== 'ok').length,
    ownerReview: workflows.filter(w => w.ownerReview).map(w => ({ path: w.path, name: w.name, flags: w.flags })),
    workflows,
  };
}
