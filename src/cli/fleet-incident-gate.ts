/**
 * `ashlr fleet incident-gate` — incident-to-gate hardening.
 *
 * Mines metrics/jobs.jsonl and dispatch-events.log for repeated failure
 * classes and, with --apply, tightens the gate that owns each one instead of
 * leaving a note: lane-error classes get a bounded lane hold through the
 * guarded slots.json writer (`fleet lane-hold` path, held_by
 * 'phantom incident-gate'), test-failure and merge-conflict classes get a
 * bounded repo cooldown hold (setRepoHold kind 'cooldown'). Every decision
 * is appended to ~/.ashlr/fleet/incident-gates.jsonl and the firedAt
 * watermarks in incident-gate.json mean a class refires only on NEW
 * repeats — reruns never double-hold.
 *
 * Without --apply this is a dry run: it prints the classes it found and the
 * tightenings it would apply, and writes nothing. Advisory gates only —
 * manual holds are never overwritten and every hold is bounded.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  advanceIncidentGateState,
  appendIncidentGateLedger,
  evaluateIncidentGate,
  loadIncidentGateState,
  mineIncidentSignals,
  readIncidentGateSources,
  saveIncidentGateState,
  INCIDENT_WINDOW_MS,
  type IncidentClassKind,
  type IncidentGateSources,
  type IncidentTighteningPlan,
} from '../core/fleet/incident-gate.js';
import { placeLaneHold } from '../core/fleet/runs-lane-hold-place.js';
import { LaneHoldError } from '../core/fleet/runs-lane-hold.js';
import { setRepoHold } from '../core/fleet/quarantine.js';
import type { RepoHoldChange, SetRepoHoldRequest } from '../core/fleet/fleet-types.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = `Usage: ashlr fleet incident-gate [--json] [--apply] [--runs-dir <abs>] [--window-hours <n>]
Mines the runs dir for repeated failure classes. Without --apply this is a
dry run that writes nothing; with --apply each tripped class tightens its
gate: lane-error -> bounded lane hold (phantom incident-gate), test-failure
and merge-conflict -> bounded repo cooldown. Every decision is recorded in
~/.ashlr/fleet/incident-gates.jsonl.`;

const MAX_WINDOW_HOURS = 24 * 366;

export interface IncidentGatePlaceOpts {
  minutes: number;
  reason: string;
  runsDir: string;
  changedBy: string;
  now: Date;
}

export interface IncidentGateCmdDeps {
  now?: () => number;
  read?: (runsDir: string) => Promise<IncidentGateSources>;
  placeHold?: (lane: string, opts: IncidentGatePlaceOpts) => Promise<unknown>;
  setHold?: (req: SetRepoHoldRequest, opts: { nowMs: number }) => RepoHoldChange;
  stateDir?: string;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

type ApplyStatus = 'applied' | 'refused' | 'error';

interface AppliedRow {
  key: string;
  cls: IncidentClassKind;
  gate: string;
  scope: string;
  count: number;
  result: ApplyStatus;
  until?: string;
  detail?: string;
}

/** Terminal outcomes advance the watermark; transient ones retry next run. */
function advances(status: ApplyStatus, gate: string): boolean {
  if (status === 'applied') return true;
  // A manual or unknown lane is already in its desired-or-impossible state.
  return status === 'refused' && gate === 'lane-hold';
}

async function applyPlan(
  plan: IncidentTighteningPlan, runsDir: string, nowMs: number, deps: IncidentGateCmdDeps,
): Promise<AppliedRow> {
  const { action } = plan;
  const base = { key: plan.key, cls: plan.cls, count: plan.count };
  if (action.gate === 'lane-hold') {
    const place = deps.placeHold ?? ((lane: string, opts: IncidentGatePlaceOpts) => placeLaneHold(lane, {
      runsDir: opts.runsDir, minutes: opts.minutes, reason: opts.reason,
      changedBy: opts.changedBy, now: () => opts.now,
    }));
    try {
      await place(action.lane, {
        minutes: action.minutes, reason: action.reason, runsDir,
        changedBy: 'incident-gate', now: new Date(nowMs),
      });
      return { ...base, gate: 'lane-hold', scope: action.lane, result: 'applied', until: new Date(nowMs + action.minutes * 60_000).toISOString() };
    } catch (error) {
      if (error instanceof LaneHoldError && (error.code === 'manual-hold' || error.code === 'unknown-lane')) {
        return { ...base, gate: 'lane-hold', scope: action.lane, result: 'refused', detail: error.code };
      }
      return { ...base, gate: 'lane-hold', scope: action.lane, result: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const set = deps.setHold ?? ((req: SetRepoHoldRequest, opts: { nowMs: number }) => setRepoHold(req, opts));
  try {
    const change = set({
      repo: action.repo, kind: action.kind, actor: 'backpressure',
      hold: { reason: action.reason, until: action.until, landingId: null },
    }, { nowMs });
    if (change.ok) {
      return { ...base, gate: 'repo-cooldown', scope: action.repo, result: 'applied', until: action.until };
    }
    return { ...base, gate: 'repo-cooldown', scope: action.repo, result: 'refused', until: action.until, detail: change.reason ?? 'refused' };
  } catch (error) {
    return { ...base, gate: 'repo-cooldown', scope: action.repo, result: 'error', until: action.until, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function cmdFleetIncidentGate(args: string[], deps: IncidentGateCmdDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, apply = false, runsDir: string | undefined, windowHours: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else if (arg === '--window-hours' && windowHours === undefined) {
      const value = args[++i];
      const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_WINDOW_HOURS) return invalid();
      windowHours = n;
    } else return invalid();
  }
  const nowMs = (deps.now ?? Date.now)();
  const root = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const stateDir = deps.stateDir ?? join(homedir(), '.ashlr', 'fleet');
  const windowMs = (windowHours ?? INCIDENT_WINDOW_MS / 3_600_000) * 3_600_000;

  const sources = await (deps.read ?? readIncidentGateSources)(root);
  const mine = mineIncidentSignals({
    jobs: sources.jobs, events: sources.events, sourceStates: sources.sources, nowMs, windowMs,
  });
  const state = loadIncidentGateState(stateDir);
  const evaluation = evaluateIncidentGate({ signals: mine.signals, state, nowMs, limits: { windowMs } });

  const applied: AppliedRow[] = [];
  if (apply) {
    for (const plan of evaluation.fired) {
      applied.push(await applyPlan(plan, root, nowMs, deps));
    }
    const advanced = applied.filter(row => advances(row.result, row.gate)).map(row => row.key);
    if (advanced.length > 0) {
      saveIncidentGateState(advanceIncidentGateState(state, advanced, nowMs), stateDir);
    }
    const rows = applied.map(row => JSON.stringify({
      v: 1, ts: new Date(nowMs).toISOString(), kind: 'incident-gate',
      cls: row.cls, key: row.key, gate: row.gate, scope: row.scope, count: row.count,
      result: row.result, ...(row.until ? { until: row.until } : {}),
      ...(row.detail ? { detail: scrubSecrets(row.detail).slice(0, 200) } : {}),
    }));
    if (rows.length > 0) await appendIncidentGateLedger(stateDir, rows);
  }

  const report = {
    schema: 'fleet.incident-gate.v1',
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: windowMs / 3_600_000,
    sources: mine.sources,
    observed: mine.observed,
    classes: evaluation.classes,
    fired: apply
      ? applied.map(row => ({ key: row.key, cls: row.cls, gate: row.gate, scope: row.scope, count: row.count, result: row.result, until: row.until ?? null }))
      : evaluation.fired.map(plan => ({
        key: plan.key, cls: plan.cls,
        gate: plan.action.gate,
        scope: plan.action.gate === 'lane-hold' ? plan.action.lane : plan.action.repo,
        count: plan.count,
        until: plan.action.gate === 'lane-hold' ? new Date(nowMs + plan.action.minutes * 60_000).toISOString() : plan.action.until,
        result: null,
      })),
  };
  if (json) {
    output(JSON.stringify(sanitizePublicJson(report)));
  } else {
    const lines = [
      `incident-gate: ${apply ? 'APPLY' : 'DRY-RUN — no changes made'}; ` +
      `jobs=${mine.sources.jobs} events=${mine.sources.events}; ${mine.observed} signals, ${evaluation.classes.length} classes`,
    ];
    for (const row of report.fired) {
      lines.push(`  ${row.result === null ? 'PLAN ' : `${String(row.result).toUpperCase()} `}${row.cls} ${row.key} (${row.count}) -> ${row.gate} ${row.scope}${row.until ? ` until ${row.until}` : ''}`);
    }
    if (report.fired.length === 0) lines.push('  no repeated failure class at threshold');
    output(lines.join('\n'));
  }
  const degraded = Object.values(mine.sources).includes('unreadable');
  const failed = applied.some(row => row.result === 'error');
  return degraded || failed ? 1 : 0;
}
