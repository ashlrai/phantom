/** The Nov 3 origin/master bulk rewrite must not attribute unrelated files to a job. */
export const BULK_COMMIT_MIN_FILES = 500;

export function isBulkCommit(filesChanged: number | null): boolean {
  return filesChanged !== null && filesChanged >= BULK_COMMIT_MIN_FILES;
}
