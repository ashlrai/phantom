/**
 * routes/verse/library/library-leader-files-model.ts: pure helpers for the
 * Library's "Leader files" section. The response is untrusted: a malformed
 * body is rejected whole rather than shown as a partial (or empty) list, and
 * every string renders as plain text.
 */
export const LEADER_FILE_PREVIEW_MAX = 240;

export interface LeaderFile { name: string; size: number; modifiedAt: string; preview: string }
export type LeaderFilesState = 'unavailable' | 'absent';
export interface LeaderFilesResponse { v: 1; observedAt: string; files: LeaderFile[]; state?: LeaderFilesState }
export interface LeaderFileRow { key: string; label: string; age: string; size: string; preview: string }

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isTime = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
// Names are relative to the leader directory: a top-level file or drafts/<file>; never a path.
const SAFE_NAME = /^(?:[^/\\\0]+|drafts\/[^/\\\0]+)$/;

function validFile(row: unknown): row is LeaderFile {
  return record(row) && typeof row.name === 'string' && SAFE_NAME.test(row.name) && row.name !== '..'
    && Number.isSafeInteger(row.size) && (row.size as number) >= 0
    && isTime(row.modifiedAt) && typeof row.preview === 'string' && row.preview.length <= LEADER_FILE_PREVIEW_MAX;
}

export function narrowLeaderFiles(x: unknown): LeaderFilesResponse | null {
  if (!record(x) || x.v !== 1 || !isTime(x.observedAt) || !Array.isArray(x.files) || !x.files.every(validFile)) return null;
  if (x.state !== undefined && x.state !== 'unavailable' && x.state !== 'absent') return null;
  if (x.state !== undefined && x.files.length > 0) return null;
  return x as unknown as LeaderFilesResponse;
}

export function leaderFileLabel(name: string): string {
  switch (name) {
    case 'VISION.md': return 'Vision';
    case 'PLAN-LOG.md': return 'Plan log';
    case 'INSPIRATION.md': return 'Inspiration';
    default: return `Draft: ${name.replace(/^drafts\//, '').replace(/\.md$/, '')}`;
  }
}

export function leaderFileAge(modifiedAt: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(modifiedAt)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

export function leaderFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Newest first; the server order breaks ties (the sort is stable). */
export function leaderFileRows(files: readonly LeaderFile[], now: number): LeaderFileRow[] {
  return files.map((file, index) => ({ file, index, at: Date.parse(file.modifiedAt) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ file }) => ({ key: file.name, label: leaderFileLabel(file.name), age: leaderFileAge(file.modifiedAt, now),
      size: leaderFileSize(file.size), preview: file.preview }));
}
