import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readGmailArchivePlanLatest, type GmailArchivePlanEntry } from '../core/comms/gmail-archive-plan-latest.js';
import { readGmailTriageInboxReports, type GmailTriageLatest } from '../core/comms/gmail-triage-latest.js';

const USAGE = `Usage: ashlr fleet gmail-status [--runs-dir <dir>] [--json]
Report the saved Gmail evidence under <runs-dir>/comms: the latest triage counts
and the per-inbox archive plans. Counts are saved export samples only — the live
inbox state is unknown and archive execution is unverified. Missing, unreadable
or invalid evidence is reported as missing; that is an observable state, not a
healthy inbox. No senders, subjects, paths, ids or bodies are printed.`;

const MAX_STAMP = 64;

interface EvidenceStamp {
  at: string | null;
  ageSeconds: number | null;
}

interface TriageCounts {
  scanned: number;
  updates: number;
  drafted: number;
  review: number;
  failed: number;
  unreadInSample: number;
  target: number;
  archiveCandidateCount: number;
}

interface TriageStatus extends EvidenceStamp {
  state: 'present' | 'missing';
  label: string | null;
  counts: TriageCounts | null;
  scope?: GmailTriageLatest['scope'];
}

interface ArchivePlanStatus extends EvidenceStamp {
  inbox: string;
  unread: number;
  target: number;
  archiveCount: number;
  scope?: GmailArchivePlanEntry['scope'];
}

interface ArchiveStatus {
  state: 'present' | 'missing';
  planCount: number;
  plans: ArchivePlanStatus[];
}

export interface GmailStatusReport {
  schema: 'fleet.gmail-status.v1';
  at: string;
  countsDescribe: 'saved-export-samples';
  liveInbox: 'unknown';
  archiveExecution: 'unverified';
  triage: TriageStatus;
  triageInboxes: TriageStatus[];
  archivePlans: ArchiveStatus;
}

/** Directory labels only: reduce any stored value to its final path segment so a
 * hand-edited store cannot leak a path through the report. */
function labelOf(value: string): string {
  return basename(value.replace(/\\/g, '/')).slice(0, MAX_STAMP);
}

function stampOf(at: string): string {
  return at.slice(0, MAX_STAMP);
}

/** Null when the stored timestamp does not parse; a future timestamp stays
 * negative so clock skew remains visible instead of being hidden. */
function ageSecondsOf(at: string, nowMs: number): number | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? Math.floor((nowMs - ms) / 1000) : null;
}

function formatAge(ageSeconds: number | null): string {
  return ageSeconds === null ? 'unknown' : ageSeconds < 0 ? `${ageSeconds}s (clock skew)` : `${ageSeconds}s`;
}

function formatScope(scope: GmailTriageLatest['scope']): string {
  return scope === undefined ? 'scope unknown'
    : `scope ${scope.source}; scan limit ${scope.limit}; saved files ${scope.files}; truncated ${scope.truncated}`;
}

/** Reads both saved stores independently: missing triage never hides archive
 * plans and missing archive never hides triage. Never throws — the readers
 * already return null on absent, unreadable, oversized or invalid content. */
export function buildGmailStatusReport(runsDir: string, now: () => number = Date.now): GmailStatusReport {
  const nowMs = now();
  const triageStore = readGmailTriageInboxReports(runsDir);
  const triageRecord = triageStore?.latest ?? null;
  const archiveStore = readGmailArchivePlanLatest(runsDir);

  const projectTriage = (triageRecord: GmailTriageLatest): TriageStatus => ({
        state: 'present',
        at: stampOf(triageRecord.at),
        ageSeconds: ageSecondsOf(triageRecord.at, nowMs),
        label: labelOf(triageRecord.dir),
        ...(triageRecord.scope === undefined ? {} : { scope: triageRecord.scope }),
        counts: {
          scanned: triageRecord.scanned,
          updates: triageRecord.updates,
          drafted: triageRecord.drafted,
          review: triageRecord.review,
          failed: triageRecord.failed,
          unreadInSample: triageRecord.unreadInSample,
          target: triageRecord.target,
          archiveCandidateCount: triageRecord.archiveCandidateCount,
        },
      });
  const triage: TriageStatus = triageRecord === null
    ? { state: 'missing', at: null, ageSeconds: null, label: null, counts: null }
    : projectTriage(triageRecord);
  const triageInboxes = (triageStore?.inboxes ?? []).map(projectTriage)
    .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '') || (a.at ?? '').localeCompare(b.at ?? ''));

  const plans: ArchivePlanStatus[] = (archiveStore?.plans ?? []).map(plan => ({
    inbox: labelOf(plan.inbox),
    at: stampOf(plan.at),
    ageSeconds: ageSecondsOf(plan.at, nowMs),
    unread: plan.unread,
    target: plan.target,
    archiveCount: plan.archiveCount,
    ...(plan.scope === undefined ? {} : { scope: plan.scope }),
  })).sort((a, b) => a.inbox.localeCompare(b.inbox) || (a.at ?? '').localeCompare(b.at ?? ''));

  const archivePlans: ArchiveStatus = archiveStore === null
    ? { state: 'missing', planCount: 0, plans: [] }
    : { state: 'present', planCount: plans.length, plans };

  return {
    schema: 'fleet.gmail-status.v1',
    at: new Date(nowMs).toISOString(),
    countsDescribe: 'saved-export-samples',
    liveInbox: 'unknown',
    archiveExecution: 'unverified',
    triage,
    triageInboxes,
    archivePlans,
  };
}

export async function cmdFleetGmailStatus(
  args: string[],
  opts: { runsDir?: string; now?: () => number } = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let runsDirFlag: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) runsDirFlag = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  const envRunsDir = process.env.ASHLR_RUNS_DIR?.trim();
  const runsDir = opts.runsDir ?? runsDirFlag ?? (envRunsDir ? envRunsDir : join(homedir(), '.ashlr-runs'));
  const report = buildGmailStatusReport(runsDir, opts.now ?? Date.now);

  if (json) {
    console.log(JSON.stringify(report));
    return 0;
  }

  console.log('Gmail saved evidence — counts are saved export samples; live inbox state unknown; archive execution unverified.');
  const triage = report.triage;
  if (triage.state === 'missing') {
    console.log('Triage: missing — no saved triage report.');
  } else {
    const c = triage.counts!;
    console.log(`Triage: present — label "${triage.label}"; saved ${triage.at}; age ${formatAge(triage.ageSeconds)}; `
      + `scanned ${c.scanned}; updates ${c.updates}; drafted ${c.drafted}; review ${c.review}; failed ${c.failed}; `
      + `unread-in-sample ${c.unreadInSample}; target ${c.target}; archive candidates ${c.archiveCandidateCount}; ${formatScope(triage.scope)}.`);
  }
  console.log(`Triage inbox reports: ${report.triageInboxes.length} saved labels.`);
  for (const entry of report.triageInboxes) {
    const c = entry.counts!;
    console.log(`- "${entry.label}": saved ${entry.at}; age ${formatAge(entry.ageSeconds)}; `
      + `scanned ${c.scanned}; updates ${c.updates}; drafted ${c.drafted}; review ${c.review}; failed ${c.failed}; `
      + `unread-in-sample ${c.unreadInSample}; target ${c.target}; archive candidates ${c.archiveCandidateCount}; ${formatScope(entry.scope)}.`);
  }
  if (report.archivePlans.state === 'missing') {
    console.log('Archive plans: missing — no saved archive plans.');
  } else {
    console.log(`Archive plans: ${report.archivePlans.planCount} saved ${report.archivePlans.planCount === 1 ? 'inbox' : 'inboxes'} (plans only — execution unverified).`);
    for (const plan of report.archivePlans.plans) {
      console.log(`- "${plan.inbox}": saved ${plan.at}; age ${formatAge(plan.ageSeconds)}; unread ${plan.unread}; target ${plan.target}; archive count ${plan.archiveCount}; `
        + (plan.scope === undefined ? 'scope unknown' : `scope ${plan.scope.source}; scanned ${plan.scope.scanned}; scan limit ${plan.scope.limit}; saved files ${plan.scope.files}; truncated ${plan.scope.truncated}; unread is not a live total`) + '.');
    }
  }
  return 0;
}
