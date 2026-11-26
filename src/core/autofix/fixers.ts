/**
 * Release, lane, load and pinned-file fixers.
 * None of them edit dispatchd.py, launch.sh, publish.sh, sandbox profiles,
 * or the other pinned names. A hand edit of an installed pinned file is
 * reported for Security and left in place.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ledgerLine, scrubText, skipIfRecorded } from './guard.js';
import type { FixContext } from './launchd.js';
import {
  AUDIT_REPO, AUDIT_WORKFLOW, LANE_RE, LOAD_PER_CPU, NICE_BATCH, NICE_NORMAL, PINNED_NAMES, RELEASE_LABEL, SHA_RE,
  type LaneLease, type LaneView, type LedgerLine, type PinnedFile, type Proc, type ReleaseDraft,
} from './types.js';

const TAG_RE = /v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/;
const TAG_EXACT = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const LEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const INTERACTIVE = new Set([
  'cursor', 'code', 'terminal', 'iterm2', 'iterm', 'finder', 'safari', 'google chrome', 'chrome',
  'firefox', 'slack', 'messages', 'mail', 'discord', 'electron', 'loginwindow', 'windowserver',
  'systemuiserver', 'spotlight',
]);
const KERNEL = new Set(['kernel_task', 'launchd', 'kthreadd', 'init', 'systemd']);
const BATCH = new Set([
  'backupd', 'mds', 'mds_stores', 'photoanalysisd', 'mediaanalysisd', 'knowledge-agent',
  'biomesyncd', 'replayd', 'suggestd', 'cloudd', 'bird', 'restock.py', 'batch-launch.sh',
]);

export function isSandboxProfileName(name: string): boolean {
  return name.endsWith('.sb') || name.includes('sandbox-profile');
}

function isPinnedName(name: string): boolean {
  return (PINNED_NAMES as readonly string[]).includes(name) || isSandboxProfileName(name);
}

export function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The autorun log names this tag sha on the audit-absent line or the few lines above it. */
function auditAbsentForSha(log: string, sha: string): boolean {
  if (!SHA_RE.test(sha)) return false;
  const prefix = sha.slice(0, 12);
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes('audit absent')) continue;
    const window = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
    if (window.includes(sha) || window.includes(prefix)) return true;
  }
  return false;
}

export function tagOf(text: string): string | null {
  return TAG_RE.exec(text)?.[0] ?? null;
}

function semver(tag: string): [number, number, number] | null {
  if (!TAG_EXACT.test(tag)) return null;
  const parts = tag.slice(1).split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

function semverCmp(left: [number, number, number], right: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! - right[i]!;
  }
  return 0;
}

/** A higher semver that is not a draft has published. Drafts and tags are never changed. */
export function newerReleasePublished(tag: string, releases: readonly ReleaseDraft[]): boolean {
  const mine = semver(tag);
  if (!mine) return false;
  return releases.some((release) => {
    if (release.draft) return false;
    const other = semver(release.tag);
    return other !== null && semverCmp(other, mine) > 0;
  });
}

export function laneTargetFromSlots(text: string | null, lane: string): number | null {
  if (!text || !LANE_RE.test(lane)) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const body = parsed.lanes && typeof parsed.lanes === 'object' && !Array.isArray(parsed.lanes)
      ? parsed.lanes as Record<string, unknown>
      : parsed;
    const row = body[lane];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const target = (row as { target?: unknown }).target;
    return typeof target === 'number' && Number.isInteger(target) && target >= 0 ? target : null;
  } catch {
    return null;
  }
}

export function fixReleaseStuckDraft(release: ReleaseDraft, log: string, ctx: FixContext): LedgerLine[] {
  const ts = ctx.host.now().toISOString();
  const target = `${release.tag}#${release.id}`;
  const before = { id: release.id, tag: release.tag, sha: release.sha, assetCount: release.assetCount };
  const kick = `gui/${ctx.host.uid()}/${RELEASE_LABEL}`;
  const kickLine = ledgerLine(ts, 'release-stuck-draft', target, 'kickstart-release-autorun', before, { kicked: kick }, ctx.dryRun ? 'dry-run' : 'applied');
  const lines: LedgerLine[] = [];
  if (ctx.dryRun) lines.push(kickLine);
  else {
    const skipped = skipIfRecorded(ctx.ledger, kickLine);
    if (skipped) lines.push(skipped);
    else {
      const result = ctx.host.exec(['launchctl', 'kickstart', kick]);
      lines.push(result.code === 0
        ? kickLine
        : ledgerLine(ts, 'release-stuck-draft', target, 'kickstart-release-autorun', before, { code: result.code }, 'failed'));
    }
  }
  if (!auditAbsentForSha(log, release.sha)) return lines;
  const auditBefore = { tag: release.tag, sha: release.sha };
  const auditLine = ledgerLine(ts, 'release-stuck-draft', release.tag, 'dispatch-dependency-audit', auditBefore, {
    workflow: AUDIT_WORKFLOW, ref: release.tag,
  }, ctx.dryRun ? 'dry-run' : 'applied');
  if (ctx.dryRun) {
    lines.push(auditLine);
    return lines;
  }
  const auditSkipped = skipIfRecorded(ctx.ledger, auditLine);
  if (auditSkipped) {
    lines.push(auditSkipped);
    return lines;
  }
  const argv = ['gh', 'workflow', 'run', AUDIT_WORKFLOW, '--repo', AUDIT_REPO, '--ref', release.tag] as const;
  const dispatched = ctx.host.exec(argv);
  lines.push(dispatched.code === 0
    ? auditLine
    : ledgerLine(ts, 'release-stuck-draft', release.tag, 'dispatch-dependency-audit', auditBefore, { code: dispatched.code }, 'failed'));
  return lines;
}

function leaseIsStale(lease: LaneLease, nowMs: number, stuckMs: number): boolean {
  if (!LEASE_RE.test(lease.id)) return false;
  if (lease.expiresAtMs !== null && lease.expiresAtMs <= nowMs) return true;
  return lease.expiresAtMs === null && !lease.manifestPresent && nowMs - lease.mtimeMs >= stuckMs;
}

export async function fixStuckLane(lane: LaneView, ctx: FixContext, stuckMs: number): Promise<LedgerLine[]> {
  const nowMs = ctx.host.now().getTime();
  const ts = new Date(nowMs).toISOString();
  const lines: LedgerLine[] = [];
  const stale = lane.leases.filter((lease) => leaseIsStale(lease, nowMs, stuckMs));
  for (const lease of stale) {
    const path = join(ctx.host.runsDir(), 'queue', 'run', `${lease.id}.batched`);
    const before = { id: lease.id, expiresAtMs: lease.expiresAtMs, path };
    const action = 'reap-stale-lease';
    if (!ctx.host.exists(path)) {
      lines.push(ledgerLine(ts, 'stuck-lane', lease.id, action, before, { reaped: false }, 'skipped'));
      continue;
    }
    if (ctx.dryRun) {
      lines.push(ledgerLine(ts, 'stuck-lane', lease.id, action, before, { reaped: true }, 'dry-run'));
      continue;
    }
    const planned = ledgerLine(ts, 'stuck-lane', lease.id, action, before, { reaped: true }, 'applied');
    const skipped = skipIfRecorded(ctx.ledger, planned);
    if (skipped) {
      lines.push(skipped);
      continue;
    }
    ctx.host.unlink(path);
    lines.push(planned);
  }
  const before = {
    lane: lane.lane,
    running: lane.running,
    lastProgressAtMs: lane.lastProgressAtMs,
    stale: stale.map((lease) => lease.id),
  };
  const action = 'restart-lane-pool';
  if (ctx.dryRun) {
    lines.push(ledgerLine(ts, 'stuck-lane', lane.lane, action, before, { restarted: true }, 'dry-run'));
    return lines;
  }
  const planned = ledgerLine(ts, 'stuck-lane', lane.lane, action, before, { restarted: true }, 'applied');
  const skipped = skipIfRecorded(ctx.ledger, planned);
  if (skipped) {
    lines.push(skipped);
    return lines;
  }
  try {
    const restarted = await ctx.host.restartLanePool(lane.lane);
    lines.push(ledgerLine(ts, 'stuck-lane', lane.lane, action, before, restarted, 'applied'));
  } catch (error) {
    lines.push(ledgerLine(ts, 'stuck-lane', lane.lane, action, before, {
      error: scrubText(error instanceof Error ? error.message : 'restart failed', 200),
    }, 'failed'));
  }
  return lines;
}

function commBase(comm: string): string {
  const base = comm.split('/').pop() ?? comm;
  return base.toLowerCase();
}

export function isDispatchdBinary(comm: string): boolean {
  const base = commBase(comm);
  return base === 'dispatchd' || base === 'dispatchd.py';
}

function loadBlocks(proc: Proc): 'kernel' | 'dispatchd' | 'interactive' | null {
  if (proc.pid <= 1) return 'kernel';
  const base = commBase(proc.comm);
  if (proc.dispatchdOwned || isDispatchdBinary(proc.comm)) return 'dispatchd';
  if (KERNEL.has(base) || base.startsWith('[') || (proc.uid === 0 && base.startsWith('kernel'))) return 'kernel';
  if (INTERACTIVE.has(base)) return 'interactive';
  return null;
}

function niceTarget(proc: Proc): number {
  return BATCH.has(commBase(proc.comm)) ? NICE_BATCH : NICE_NORMAL;
}

export function fixOutsideLoad(load1: number, ncpu: number, loadPerCpu: number, processes: readonly Proc[], ctx: FixContext): LedgerLine[] {
  const target = (loadPerCpu > 0 ? loadPerCpu : LOAD_PER_CPU) * ncpu;
  if (!(load1 > target) || ncpu < 1) return [];
  const ts = ctx.host.now().toISOString();
  const lines: LedgerLine[] = [];
  for (const proc of processes) {
    const block = loadBlocks(proc);
    if (block) continue;
    const nice = niceTarget(proc);
    const before = { pid: proc.pid, comm: proc.comm, nice: proc.nice, load1, loadTarget: target };
    const action = `renice-${nice}`;
    if (proc.nice >= nice) continue;
    if (ctx.dryRun) {
      lines.push(ledgerLine(ts, 'outside-load', String(proc.pid), action, before, { nice }, 'dry-run'));
      continue;
    }
    const planned = ledgerLine(ts, 'outside-load', String(proc.pid), action, before, { nice }, 'applied');
    const skipped = skipIfRecorded(ctx.ledger, planned);
    if (skipped) {
      lines.push(skipped);
      continue;
    }
    const result = ctx.host.exec(['renice', '-n', String(nice), '-p', String(proc.pid)]);
    lines.push(result.code === 0
      ? planned
      : ledgerLine(ts, 'outside-load', String(proc.pid), action, before, { code: result.code }, 'failed'));
  }
  return lines;
}

export function pinnedDrift(file: PinnedFile): boolean {
  if (!isPinnedName(file.name)) return false;
  if (!file.installedSha256 || !file.expectedSha256) return false;
  return file.installedSha256.toLowerCase() !== file.expectedSha256.toLowerCase();
}

export function reportPinnedHandEdit(file: PinnedFile, ctx: FixContext): LedgerLine {
  const ts = ctx.host.now().toISOString();
  const before = {
    name: file.name,
    installed: `sha256:${file.installedSha256}`,
    expected: `sha256:${file.expectedSha256}`,
  };
  const report = {
    schema: 'autofix.pinned-hand-edit.v1',
    file: file.name,
    installedPath: file.installedPath,
    installedSha256: `sha256:${file.installedSha256}`,
    expectedSha256: `sha256:${file.expectedSha256}`,
    action: 'detect-only',
    note: 'Hand edit detected on an installed pinned file. Security reviews it. Autofix did not change the file.',
  };
  const line = ledgerLine(ts, 'pinned-hand-edit', file.name, 'security-report', before, { detectOnly: true }, 'detect-only');
  const skipped = skipIfRecorded(ctx.ledger, line);
  if (skipped) return skipped;
  if (ctx.dryRun) {
    return ledgerLine(ts, 'pinned-hand-edit', file.name, 'security-report', before, { detectOnly: true }, 'dry-run');
  }
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(ctx.host.runsDir(), 'ledger', 'autofix-security', `${safe}.json`);
  ctx.host.writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return ledgerLine(ts, 'pinned-hand-edit', file.name, 'security-report', before, { detectOnly: true, report: path }, 'detect-only');
}
