/**
 * One autofix tick. The input is Eng Ops incident filenames under
 * ~/.ashlr-runs/bus/core/. The markdown body is not read. A fixed prefix
 * table selects the fixer. Outcomes append to ledger/incidents.jsonl.
 * ~/.ashlr/KILL refuses the tick before any action.
 */
import { join } from 'node:path';

import { fixOutsideLoad, fixReleaseStuckDraft, fixStuckLane, pinnedDrift, reportPinnedHandEdit } from './fixers.js';
import { appendLedger, ledgerPath, readLedger } from './guard.js';
import {
  formatIncidentLine, holdReportPath, incidentDir, incidentsLedgerPath, jobForLabel,
  laneFromKey, launchdLabelFromKey, parseIncidentFilename, readIncidentStatuses,
  securityReportForHold, slotsTarget, supersededReason, tagFromIncidentKey, terminalIncident,
} from './incidents.js';
import { fixLaunchdCrashloop, type FixContext } from './launchd.js';
import {
  DEFAULT_STUCK_MIN, FIXER_IDS,
  type AutofixHost, type AutofixSnapshot, type FixerId, type IncidentStatusLine, type LaneView, type LedgerLine,
} from './types.js';

export interface RunAutofixOptions {
  host: AutofixHost;
  snapshot: AutofixSnapshot;
  dryRun: boolean;
  only?: readonly FixerId[];
  olderThanMin?: number;
  stuckMinutes?: number;
}

export interface RunAutofixResult {
  exitCode: number;
  killed: boolean;
  lines: LedgerLine[];
  incidents: IncidentStatusLine[];
}

function selected(only: readonly FixerId[] | undefined, id: FixerId): boolean {
  return !only || only.length === 0 || only.includes(id);
}

function statusOf(lines: readonly LedgerLine[]): { status: IncidentStatusLine['status']; reason: string } {
  const intentional = lines.find((line) => line.action === 'superseded' || line.action === 'lane-target-off');
  if (intentional) return { status: 'intentional', reason: intentional.action };
  if (lines.some((line) => line.result === 'failed')) {
    return { status: 'failed', reason: lines.find((line) => line.result === 'failed')?.action ?? 'failed' };
  }
  const applied = lines.find((line) => line.result === 'applied' || line.result === 'dry-run');
  if (applied) return { status: 'fixed', reason: applied.action };
  const refused = lines.find((line) => line.result === 'refused' || line.result === 'refused_admitted'
    || line.result === 'refused_stale' || line.result === 'refused_operator' || line.result === 'detect-only');
  if (refused) return { status: 'refused', reason: refused.result === 'detect-only' ? 'detect-only-security' : refused.action };
  return { status: 'refused', reason: 'no-action' };
}

function closedIncident(line: IncidentStatusLine): boolean {
  if (line.status === 'fixed' || line.status === 'intentional') return true;
  return line.status === 'refused' && (line.reason === 'detect-only-security' || line.reason === 'unknown-prefix');
}

export async function runAutofix(opts: RunAutofixOptions): Promise<RunAutofixResult> {
  if (opts.host.exists(opts.host.killPath())) return { exitCode: 3, killed: true, lines: [], incidents: [] };
  const ledger = readLedger(opts.host.readText(ledgerPath(opts.host.runsDir())));
  const priorIncidents = readIncidentStatuses(opts.host.readText(incidentsLedgerPath(opts.host.runsDir())));
  const ctx: FixContext = { host: opts.host, dryRun: opts.dryRun, ledger };
  const lines: LedgerLine[] = [];
  const incidents: IncidentStatusLine[] = [];
  const push = (batch: LedgerLine | LedgerLine[] | null): void => {
    const rows = batch === null ? [] : Array.isArray(batch) ? batch : [batch];
    for (const line of rows) {
      if (line.result !== 'skipped') appendLedger(opts.host, line);
      ledger.push(line);
      lines.push(line);
    }
  };
  const record = (line: IncidentStatusLine): void => {
    incidents.push(line);
    if (!opts.dryRun) {
      opts.host.appendFile(incidentsLedgerPath(opts.host.runsDir()), `${formatIncidentLine(line)}\n`);
      priorIncidents.push(line);
    }
  };
  for (const file of opts.snapshot.pinned) {
    if (pinnedDrift(file)) push(reportPinnedHandEdit(file, ctx));
  }
  const names = opts.host.listDir(incidentDir(opts.host.runsDir())).filter((name) => name.startsWith('INCIDENT-')).sort();
  const stuckMs = (opts.stuckMinutes ?? DEFAULT_STUCK_MIN) * 60_000;
  for (const name of names) {
    const parsed = parseIncidentFilename(name);
    if (!parsed) continue;
    if (!('fixer' in parsed)) {
      const repeat = priorIncidents.find((line) => line.key === parsed.key && line.reason === parsed.reason);
      if (!repeat) record({ key: parsed.key, status: 'refused', reason: parsed.reason, ts: opts.host.now().toISOString() });
      continue;
    }
    const previous = terminalIncident(priorIncidents, parsed.key);
    if (previous && closedIncident(previous)) continue;
    const ts = opts.host.now().toISOString();
    if (parsed.fixer === 'autorun-hold') {
      const path = holdReportPath(opts.host.runsDir(), parsed.key);
      if (!opts.dryRun) opts.host.writeFile(path, securityReportForHold(parsed.key, ts));
      push({
        ts, fixer: 'pinned-hand-edit', target: parsed.key, action: 'security-report',
        before: { key: parsed.key }, after: { detectOnly: true, report: opts.dryRun ? null : path },
        result: opts.dryRun ? 'dry-run' : 'detect-only',
      });
      record({ key: parsed.key, status: 'refused', reason: 'detect-only-security', ts });
      continue;
    }
    const fixer = parsed.fixer;
    if (!selected(opts.only, fixer)) continue;
    const before = lines.length;
    if (fixer === 'release-stuck-draft') runRelease(parsed.key, opts, ctx, push);
    else if (fixer === 'launchd-crashloop') runLaunchd(parsed.key, opts, ctx, push);
    else if (fixer === 'stuck-lane') await runLane(parsed.key, opts, ctx, push, stuckMs);
    else if (fixer === 'outside-load') runLoad(opts, ctx, push);
    else {
      const unreachable: never = fixer;
      throw new Error(`unhandled fixer ${String(unreachable)}`);
    }
    const acted = lines.slice(before);
    const outcome = statusOf(acted);
    const previousSame = [...priorIncidents].reverse().find((line) => line.key === parsed.key);
    if (previousSame && previousSame.status === outcome.status && previousSame.reason === outcome.reason) continue;
    record({ key: parsed.key, status: outcome.status, reason: outcome.reason, ts });
  }
  const failed = lines.some((line) => line.result === 'failed') || incidents.some((line) => line.status === 'failed');
  return { exitCode: failed ? 1 : 0, killed: false, lines, incidents };
}

function runRelease(key: string, opts: RunAutofixOptions, ctx: FixContext, push: (line: LedgerLine | LedgerLine[] | null) => void): void {
  const tag = tagFromIncidentKey(key);
  const ts = opts.host.now().toISOString();
  if (!tag) {
    push({ ts, fixer: 'release-stuck-draft', target: key, action: 'refuse-no-tag', before: { key }, after: {}, result: 'refused' });
    return;
  }
  if (supersededReason(key, opts.snapshot.releases)) {
    push({
      ts, fixer: 'release-stuck-draft', target: tag, action: 'superseded',
      before: { tag }, after: { publishedNewer: true }, result: 'skipped',
    });
    return;
  }
  const release = opts.snapshot.releases.find((item) => item.tag === tag && item.draft && item.assetCount === 0);
  if (!release || !opts.snapshot.attestShas.includes(release.sha)) {
    push({
      ts, fixer: 'release-stuck-draft', target: tag, action: 'refuse-attest',
      before: { tag }, after: {}, result: 'refused',
    });
    return;
  }
  push(fixReleaseStuckDraft(release, opts.snapshot.autorunLog, ctx));
}

function runLaunchd(key: string, opts: RunAutofixOptions, ctx: FixContext, push: (line: LedgerLine | LedgerLine[] | null) => void): void {
  const label = launchdLabelFromKey(key);
  const ts = opts.host.now().toISOString();
  if (!label) {
    push({ ts, fixer: 'launchd-crashloop', target: key, action: 'refuse-label', before: { key }, after: {}, result: 'refused' });
    return;
  }
  const plist = join(opts.host.homeDir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const dir = join(opts.host.homeDir(), 'Library', 'LaunchAgents');
  let rollback: number | null = null;
  for (const name of opts.host.listDir(dir)) {
    if (!name.includes('.rollback.') || !name.startsWith(label)) continue;
    const mtime = opts.host.statMtime(join(dir, name));
    if (mtime !== null && (rollback === null || mtime > rollback)) rollback = mtime;
  }
  const job = jobForLabel(opts.snapshot, label, opts.host.statMtime(plist), rollback);
  const line = fixLaunchdCrashloop(job, ctx);
  if (line === null) {
    push({ ts, fixer: 'launchd-crashloop', target: label, action: 'refuse-stale-runs', before: { label }, after: { disabled: job.disabled }, result: 'refused_stale' });
    return;
  }
  push(line);
}

async function runLane(key: string, opts: RunAutofixOptions, ctx: FixContext, push: (line: LedgerLine | LedgerLine[] | null) => void, stuckMs: number): Promise<void> {
  const lane = laneFromKey(key);
  const ts = opts.host.now().toISOString();
  if (!lane) {
    push({ ts, fixer: 'stuck-lane', target: key, action: 'refuse-lane', before: { key }, after: {}, result: 'refused' });
    return;
  }
  const target = slotsTarget(opts.snapshot, opts.host.readText(join(opts.host.runsDir(), 'queue', 'slots.json')), lane);
  if (target === 0) {
    push({
      ts, fixer: 'stuck-lane', target: lane, action: 'lane-target-off',
      before: { lane, target: 0 }, after: { restarted: false }, result: 'skipped',
    });
    return;
  }
  if (target === null) {
    push({ ts, fixer: 'stuck-lane', target: lane, action: 'refuse-slots', before: { lane }, after: {}, result: 'refused' });
    return;
  }
  const view: LaneView = opts.snapshot.lanes.find((item) => item.lane === lane) ?? {
    lane, running: 1, lastProgressAtMs: null, target, leases: [],
  };
  push(await fixStuckLane(view, ctx, stuckMs));
}

function runLoad(opts: RunAutofixOptions, ctx: FixContext, push: (line: LedgerLine | LedgerLine[] | null) => void): void {
  const ts = opts.host.now().toISOString();
  if (opts.snapshot.load1 === null || opts.snapshot.ncpu === null) {
    push({ ts, fixer: 'outside-load', target: 'load', action: 'refuse-unmeasured', before: {}, after: {}, result: 'refused' });
    return;
  }
  const acted = fixOutsideLoad(opts.snapshot.load1, opts.snapshot.ncpu, opts.snapshot.loadPerCpu, opts.snapshot.processes, ctx);
  if (acted.length === 0) {
    push({ ts, fixer: 'outside-load', target: 'load', action: 'refuse-below-target', before: { load1: opts.snapshot.load1 }, after: {}, result: 'refused' });
    return;
  }
  push(acted);
}

export function fixerId(value: string): FixerId | null {
  if ((FIXER_IDS as readonly string[]).includes(value) || value === 'pinned-hand-edit') return value as FixerId;
  return null;
}
