/**
 * launchd-crashloop fixer.
 *
 * A disable or bootout runs only when a fresh `runs` sample is still
 * climbing by more than CRASH_THRESHOLD over the last hour. Two samples
 * at least 60s apart are required. A stale or flat count never disables.
 *
 * ai.ashlr.daemon, and any job marked authority-governed, is left alone
 * when `phm authority resident status` reports an admitted active grant
 * and a running service. A plist or `.rollback.*` sibling newer than 15
 * minutes is an operator start and is also left alone.
 */
import { join } from 'node:path';

import { alreadyRecorded, ledgerLine, scrubText } from './guard.js';
import {
  CRASH_THRESHOLD, FRESH_MS, HOUR_MS, OPERATOR_QUIET_MS, RESIDENT_LABEL, SAMPLE_GAP_MS,
  type AutofixHost, type LaunchdJob, type LedgerLine, type RunsSample,
} from './types.js';

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export type CrashReason = 'active' | 'no-samples' | 'stale' | 'gap' | 'flat' | 'below-threshold';

export interface CrashAssessment {
  active: boolean;
  reason: CrashReason;
  hourDelta: number;
  recentDelta: number;
  newestRuns: number | null;
  lastExitCode: number | null;
}

export function isAuthorityGoverned(job: { label: string; authorityGoverned?: boolean }): boolean {
  return job.authorityGoverned === true || job.label === RESIDENT_LABEL;
}

export function parseLaunchctlPrint(text: string): { runs: number; lastExitCode: number | null; pid: number | null } | null {
  const runs = /^\s*runs\s*=\s*(\d+)\s*$/m.exec(text);
  if (!runs) return null;
  const exit = /^\s*last exit code\s*=\s*(-?\d+|\(never exited\)|never exited)\s*$/m.exec(text);
  const pid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(text);
  const rawExit = exit?.[1];
  const lastExitCode = rawExit === undefined || rawExit === 'never exited' || rawExit === '(never exited)'
    ? null
    : Number(rawExit);
  return { runs: Number(runs[1]), lastExitCode, pid: pid ? Number(pid[1]) : null };
}

/**
 * Current crash rate from `runs` deltas. The newest sample must be fresh.
 * The closest sample at least 60s earlier must still be lower (the loop is
 * increasing now). The oldest sample at least 60s earlier in the hour must
 * show more than CRASH_THRESHOLD new runs.
 */
export function assessCrashRate(samples: readonly RunsSample[], nowMs: number): CrashAssessment {
  const empty: CrashAssessment = {
    active: false, reason: 'no-samples', hourDelta: 0, recentDelta: 0, newestRuns: null, lastExitCode: null,
  };
  const window = samples
    .filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.runs)
      && sample.runs >= 0 && sample.atMs <= nowMs && nowMs - sample.atMs <= HOUR_MS)
    .slice()
    .sort((a, b) => a.atMs - b.atMs || a.runs - b.runs);
  if (window.length === 0) return empty;
  const newest = window[window.length - 1]!;
  const base = { newestRuns: newest.runs, lastExitCode: newest.lastExitCode, hourDelta: 0, recentDelta: 0 };
  if (nowMs - newest.atMs > FRESH_MS) return { active: false, reason: 'stale', ...base };
  const prior = window.filter((sample) => newest.atMs - sample.atMs >= SAMPLE_GAP_MS);
  if (prior.length === 0) return { active: false, reason: 'gap', ...base };
  const recent = prior[prior.length - 1]!;
  const baseline = prior[0]!;
  const recentDelta = newest.runs - recent.runs;
  const hourDelta = newest.runs - baseline.runs;
  if (recentDelta <= 0) return { active: false, reason: 'flat', ...base, hourDelta, recentDelta };
  if (hourDelta <= CRASH_THRESHOLD) return { active: false, reason: 'below-threshold', ...base, hourDelta, recentDelta };
  return { active: true, reason: 'active', ...base, hourDelta, recentDelta };
}

export type OperatorBlock = 'plist' | 'rollback' | 'unknown-plist';

/** A recent plist write or `.rollback.*` sibling is a deliberate operator start. */
export function operatorStartRecent(plistMtimeMs: number | null, rollbackMtimeMs: number | null, nowMs: number): OperatorBlock | null {
  if (plistMtimeMs === null || !Number.isFinite(plistMtimeMs)) return 'unknown-plist';
  if (plistMtimeMs > nowMs - OPERATOR_QUIET_MS) return 'plist';
  if (rollbackMtimeMs !== null && Number.isFinite(rollbackMtimeMs) && rollbackMtimeMs > nowMs - OPERATOR_QUIET_MS) {
    return 'rollback';
  }
  return null;
}

/**
 * True only when resident status shows the exact admitted sentence (or the
 * JSON equivalent), an active grant, and the resident service running.
 */
export function residentAdmissionBlocksDisable(stdout: string): boolean {
  const text = stdout.trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as {
        admission?: { ok?: boolean; status?: string; code?: string; grantId?: unknown; expiresAt?: unknown };
        service?: { state?: string };
      };
      const admission = parsed.admission;
      const admitted = admission?.ok === true && (admission.status === 'admitted' || admission.code === 'admitted');
      const activeGrant = typeof admission?.grantId === 'string' && admission.grantId.length > 0
        && typeof admission.expiresAt === 'string' && admission.expiresAt.length > 0;
      return admitted && activeGrant && parsed.service?.state === 'running';
    } catch {
      return false;
    }
  }
  const admitted = /^Resident admission:\s+admitted\b/m.test(text);
  const activeGrant = /grant #\d+\s+is active\b/.test(text);
  const running = /^Service:\s+ai\.ashlr\.daemon\s+running\b/m.test(text);
  return admitted && activeGrant && running;
}

export interface FixContext {
  host: AutofixHost;
  dryRun: boolean;
  ledger: LedgerLine[];
}

function serviceTarget(host: AutofixHost, job: LaunchdJob): string {
  const domain = job.domain === 'user' ? 'user' : 'gui';
  return `${domain}/${host.uid()}/${job.label}`;
}

function rqPath(host: AutofixHost, label: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return join(host.runsDir(), 'ledger', 'rq', `RQ-AUTOFIX-LAUNCHD-${safe}.md`);
}

function writeRq(host: AutofixHost, label: string, body: string): string {
  const path = rqPath(host, label);
  host.writeFile(path, body);
  return path;
}

function rememberSample(host: AutofixHost, label: string, sample: RunsSample): void {
  const line = JSON.stringify({
    label, atMs: sample.atMs, runs: sample.runs, lastExitCode: sample.lastExitCode, pid: sample.pid,
  });
  host.appendFile(join(host.runsDir(), 'ledger', 'launchd-runs.jsonl'), `${line}\n`);
}

function finish(ctx: FixContext, line: LedgerLine): LedgerLine {
  const prior = alreadyRecorded(ctx.ledger, line);
  if (prior && line.result !== 'dry-run') {
    return ledgerLine(ctx.host.now().toISOString(), line.fixer, line.target, line.action, line.before, prior.after, 'skipped');
  }
  return line;
}

export function fixLaunchdCrashloop(job: LaunchdJob, ctx: FixContext): LedgerLine | null {
  const nowMs = ctx.host.now().getTime();
  const ts = new Date(nowMs).toISOString();
  if (job.domain === 'system' || !LABEL_RE.test(job.label)) {
    return ledgerLine(ts, 'launchd-crashloop', job.label, 'refuse-domain', { domain: job.domain }, { disabled: job.disabled }, 'refused');
  }
  const target = serviceTarget(ctx.host, job);
  let fresh: RunsSample | null = null;
  if (!ctx.dryRun) {
    const printed = ctx.host.exec(['launchctl', 'print', target]);
    const parsed = printed.code === 0 ? parseLaunchctlPrint(printed.stdout) : null;
    if (!parsed) {
      const hot = job.samples.some((sample) => sample.runs > CRASH_THRESHOLD);
      if (!hot) return null;
      return finish(ctx, ledgerLine(ts, 'launchd-crashloop', job.label, 'refuse-stale-runs', {
        reason: 'launchctl-print-unavailable', runs: null,
      }, { disabled: job.disabled, bootedOut: false }, 'refused_stale'));
    }
    fresh = { atMs: nowMs, runs: parsed.runs, lastExitCode: parsed.lastExitCode, pid: parsed.pid };
    rememberSample(ctx.host, job.label, fresh);
  }
  const samples = fresh ? [...job.samples, fresh] : job.samples;
  const rate = assessCrashRate(samples, nowMs);
  const before = {
    runs: rate.newestRuns,
    lastExitCode: rate.lastExitCode,
    hourDelta: rate.hourDelta,
    recentDelta: rate.recentDelta,
    reason: rate.reason,
    disabled: job.disabled,
    plistMtimeMs: job.plistMtimeMs,
    rollbackMtimeMs: job.rollbackMtimeMs,
  };
  const hot = (rate.newestRuns ?? 0) > CRASH_THRESHOLD || rate.hourDelta > CRASH_THRESHOLD
    || job.samples.some((sample) => sample.runs > CRASH_THRESHOLD);
  if (!rate.active) {
    if (!hot) return null;
    return finish(ctx, ledgerLine(ts, 'launchd-crashloop', job.label, 'refuse-stale-runs', before, {
      disabled: job.disabled, bootedOut: false,
    }, 'refused_stale'));
  }

  const operator = operatorStartRecent(job.plistMtimeMs, job.rollbackMtimeMs, nowMs);
  if (operator) {
    return finish(ctx, ledgerLine(ts, 'launchd-crashloop', job.label, 'refuse-operator-start', {
      ...before, operator,
    }, { disabled: job.disabled, bootedOut: false }, 'refused_operator'));
  }

  if (isAuthorityGoverned(job)) {
    if (ctx.dryRun) {
      return ledgerLine(ts, 'launchd-crashloop', job.label, 'disable-keepalive', before, {
        disabled: false, bootedOut: false, wouldCheckAdmission: true,
      }, 'dry-run');
    }
    const status = ctx.host.exec(['phm', 'authority', 'resident', 'status']);
    if (status.code !== 0 || !status.stdout.trim()) {
      const path = writeRq(ctx.host, job.label, rqBody(job, rate, 'admission-unknown', status.stderr || status.stdout));
      return finish(ctx, ledgerLine(ts, 'launchd-crashloop', job.label, 'refuse-admission-unknown', before, {
        disabled: job.disabled, bootedOut: false, rq: path,
      }, 'refused'));
    }
    if (residentAdmissionBlocksDisable(status.stdout)) {
      const line = ledgerLine(ts, 'launchd-crashloop', job.label, 'refuse-disable', {
        ...before, admission: 'admitted',
      }, { disabled: false, bootedOut: false }, 'refused_admitted');
      const prior = alreadyRecorded(ctx.ledger, line);
      if (prior) return ledgerLine(ts, line.fixer, line.target, line.action, line.before, prior.after, 'skipped');
      const path = writeRq(ctx.host, job.label, rqBody(job, rate, 'refused_admitted', status.stdout));
      return ledgerLine(ts, 'launchd-crashloop', job.label, 'refuse-disable', line.before, {
        disabled: false, bootedOut: false, rq: path,
      }, 'refused_admitted');
    }
  }

  if (ctx.dryRun) {
    return ledgerLine(ts, 'launchd-crashloop', job.label, 'disable-keepalive', before, {
      disabled: true, bootedOut: true,
    }, 'dry-run');
  }
  const planned = ledgerLine(ts, 'launchd-crashloop', job.label, 'disable-keepalive', before, {
    disabled: true, bootedOut: true,
  }, 'applied');
  const prior = alreadyRecorded(ctx.ledger, planned);
  if (prior) return ledgerLine(ts, planned.fixer, planned.target, planned.action, planned.before, prior.after, 'skipped');

  const disabled = ctx.host.exec(['launchctl', 'disable', target]);
  const booted = ctx.host.exec(['launchctl', 'bootout', target]);
  if (disabled.code !== 0 || booted.code !== 0) {
    return ledgerLine(ts, 'launchd-crashloop', job.label, 'disable-keepalive', before, {
      disabled: disabled.code === 0, bootedOut: booted.code === 0,
      disableCode: disabled.code, bootoutCode: booted.code,
    }, 'failed');
  }
  const path = writeRq(ctx.host, job.label, rqBody(job, rate, 'disabled', ''));
  return ledgerLine(ts, 'launchd-crashloop', job.label, 'disable-keepalive', before, {
    disabled: true, bootedOut: true, rq: path,
  }, 'applied');
}

function rqBody(job: LaunchdJob, rate: CrashAssessment, why: string, status: string): string {
  const exits = job.samples.map((sample) => sample.lastExitCode).filter((code): code is number => code !== null);
  if (rate.lastExitCode !== null) exits.push(rate.lastExitCode);
  const lines = [
    `# RQ-AUTOFIX-LAUNCHD-${job.label}`,
    '',
    'Root-cause note for a launchd job. Autofix does not sign, and this file does not change the job by itself.',
    '',
    `- label: ${job.label}`,
    `- reason: ${why}`,
    `- runs: ${rate.newestRuns ?? 'unknown'}`,
    `- hour delta: ${rate.hourDelta}`,
    `- recent delta: ${rate.recentDelta}`,
    `- last exit codes: ${exits.length ? exits.join(', ') : 'none'}`,
    '',
    '## Log tail',
    '',
    scrubText(job.logTail || '(empty)'),
    '',
  ];
  if (why === 'refused_admitted') {
    lines.push(
      'phm authority resident status reported Resident admission: admitted, with an active grant and the service running.',
      'Autofix did not disable or bootout this job. Reverse is not required.',
      '',
      '## Status excerpt',
      '',
      scrubText(status, 800),
      '',
    );
  } else if (why === 'disabled') {
    lines.push(
      'KeepAlive was disabled with launchctl disable and the user-domain job was booted out.',
      'That is reversible: launchctl enable the same target, then bootstrap the existing plist.',
      '',
    );
  } else {
    lines.push('Autofix did not disable this job because resident status could not be read.', '');
  }
  return lines.join('\n');
}
