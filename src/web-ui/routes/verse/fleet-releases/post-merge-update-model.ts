import type { ServerObservation } from '../sections/update-status-queries.js';

export type MergeNotice = { number: number | null; label: string; mergedAt: number | null };

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function numericCompare(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function newerVersion(candidate: string, current: string): boolean {
  const a = semver.exec(candidate);
  const b = semver.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const difference = numericCompare(a[i]!, b[i]!);
    if (difference) return difference > 0;
  }
  if (!a[4] || !b[4]) return !a[4] && !!b[4];
  const left = a[4].split('.');
  const right = b[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]; const y = right[i];
    if (x === undefined || y === undefined) return y === undefined;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    const difference = xn && yn ? numericCompare(x, y) : xn !== yn ? (xn ? -1 : 1) : (x < y ? -1 : x > y ? 1 : 0);
    if (difference) return difference > 0;
  }
  return false;
}

export function pollingDue(notice: MergeNotice | undefined, nowMs: number): boolean {
  return notice?.number != null && notice.mergedAt !== null && nowMs - notice.mergedAt < 45 * 60_000;
}

export function readyVersion(status: ServerObservation | undefined): string | null {
  if (!status || 'kind' in status || status.sourceState !== 'healthy') return null;
  // Older hubs do not report a candidate; never infer publication from a PR.
  const candidate = (status as { candidateVersion?: unknown }).candidateVersion;
  return typeof candidate === 'string' && status.installedVersion && newerVersion(candidate, status.installedVersion) ? candidate : null;
}

export function postMergeLine(notice: MergeNotice | undefined, status: ServerObservation | undefined, nowMs: number): string | null {
  if (notice?.number == null || notice.mergedAt === null) return null;
  const facts = status && !('kind' in status) ? status : null;
  if (facts?.lastApply?.outcome === 'updated' && Date.parse(facts.lastApply.finishedAt) >= notice.mergedAt) return 'Update applied; restart when convenient.';
  const candidate = readyVersion(status);
  if (candidate && facts?.installedVersion) return `${candidate} is ready (running ${facts.installedVersion}).`;
  const minutes = Math.floor(Math.max(0, nowMs - notice.mergedAt) / 60_000);
  return `Release PR #${notice.number} merged ${minutes} min ago. The tag workflow runs next; the update appears here when the release is published.`;
}
