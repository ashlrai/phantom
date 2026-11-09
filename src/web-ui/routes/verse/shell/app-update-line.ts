/**
 * shell/app-update-line.ts — the one line the desktop shows about a staged
 * native update ("Update 3.30.2 staged · waiting for 3 running jobs"), or
 * null when there is nothing to say. Pure: the wire read and the wording,
 * no fetch, no React. The endpoint is GET /api/verse/app/update-status
 * (core/verse/app-update-api.ts), the same read `phm app update status` does.
 */

/** Wire shape of GET /api/verse/app/update-status (v:1). */
export interface AppUpdateStatusResponse {
  v: 1;
  available: string | null;
  deferredReason: string | null;
  runningJobCount: number | null;
  unknownJobs: number | null;
}

export const APP_UPDATE_STATUS_PATH = '/api/verse/app/update-status';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const nullableCount = (value: unknown): boolean =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

/** The response read, or null for anything that is not the v:1 shape. */
export function readAppUpdateResponse(raw: unknown): AppUpdateStatusResponse | null {
  if (!record(raw) || raw.v !== 1 || !nullableString(raw.available) || !nullableString(raw.deferredReason)
    || !nullableCount(raw.runningJobCount) || !nullableCount(raw.unknownJobs)) return null;
  return raw as unknown as AppUpdateStatusResponse;
}

/**
 * The line, or null when there is nothing to say. `available` null means no
 * staged candidate (or status unreadable), so the surface shows nothing —
 * never "we do not know". A hold the host cannot name in words shows the
 * raw reason as "held: <reason>".
 */
export function appUpdateLine(status: AppUpdateStatusResponse): string | null {
  if (status.available === null) return null;
  const staged = `Update ${status.available} staged`;
  if (status.deferredReason === 'work-active-or-unknown') {
    const jobs = (status.runningJobCount ?? 0) + (status.unknownJobs ?? 0);
    return jobs > 0
      ? `${staged} · waiting for ${jobs} running ${jobs === 1 ? 'job' : 'jobs'}`
      : `${staged} · waiting for running jobs`;
  }
  if (status.deferredReason === null) return `${staged} · applies on next restart`;
  return `${staged} · held: ${status.deferredReason}`;
}
