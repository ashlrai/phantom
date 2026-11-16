/**
 * Pure file-overlap prediction used before re-arming auto-merge.
 *
 * Arming a PR that shares a file with another already-armed PR is wasted: the
 * armed one lands first, this PR turns DIRTY/BEHIND and the arm is dropped,
 * burning one of its bounded retries. Overlap is a prediction, not a measured
 * Git conflict, and missing or possibly-truncated file lists stay unknown —
 * unknown never blocks arming.
 */

/** `gh pr list --json files` caps each PR's list at 100; a full list is unproven. */
export const GH_FILE_LIST_CAP = 100;

export interface ArmSnapshotRow {
  number: number;
  isDraft: boolean;
  armed: boolean;
  files: string[] | null;
}

export type ArmConflictPrediction =
  | { state: 'clear' }
  | { state: 'unknown' }
  | { state: 'predicted-conflict'; with: number[]; shared: string[] };

const MAX_REPORTED = 5;

/** Parse a `gh pr list --json number,isDraft,autoMergeRequest,files` page; null when unusable. */
export function parseArmSnapshot(raw: unknown): ArmSnapshotRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: ArmSnapshotRow[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const row = item as Record<string, unknown>;
    if (!Number.isSafeInteger(row.number) || typeof row.isDraft !== 'boolean') return null;
    let files: string[] | null = null;
    if (Array.isArray(row.files) && row.files.length < GH_FILE_LIST_CAP) {
      const paths = row.files.map(f => (typeof f === 'object' && f !== null ? (f as { path?: unknown }).path : undefined));
      if (paths.every((p): p is string => typeof p === 'string' && p.length > 0)) files = paths;
    }
    rows.push({ number: row.number as number, isDraft: row.isDraft, armed: row.autoMergeRequest != null, files });
  }
  return rows;
}

/** Does `pr` share a file with any other armed, non-draft PR? */
export function predictArmConflict(pr: number, rows: readonly ArmSnapshotRow[] | null): ArmConflictPrediction {
  const own = rows?.find(row => row.number === pr)?.files;
  if (!own || own.length === 0) return { state: 'unknown' };
  const mine = new Set(own);
  const withPrs: number[] = [];
  const shared = new Set<string>();
  for (const other of rows!) {
    if (other.number === pr || !other.armed || other.isDraft || !other.files) continue;
    const overlap = other.files.filter(file => mine.has(file));
    if (overlap.length === 0) continue;
    withPrs.push(other.number);
    for (const file of overlap) shared.add(file);
  }
  return withPrs.length === 0 ? { state: 'clear' }
    : { state: 'predicted-conflict', with: withPrs.slice(0, MAX_REPORTED), shared: [...shared].sort().slice(0, MAX_REPORTED) };
}
