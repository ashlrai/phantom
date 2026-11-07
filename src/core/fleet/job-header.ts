/**
 * Pure validator for the `#job` header that must be a job file's first line.
 * Ingest drops files whose line 1 does not match exactly, silently — verbs use
 * this to reject a bad job before it is ever queued.
 */

const FIELD = '[a-z0-9-]+';
const TIERS = new Set(['fast', 'mid', 'work', 'frontier']);
const HEADER = new RegExp(`^#job repo=(${FIELD}) lane=(${FIELD}) tier=(${FIELD})$`);
/** `RQ-PHX-<id>.md` — the file name ingest requires for repo=phantom jobs. */
const PHANTOM_FILE = /^RQ-PHX-[A-Z0-9]{3,40}\.md$/;

export type JobHeader =
  | { ok: true; repo: string; lane: string; tier: string }
  | { ok: false; error: string };

export function parseJobHeader(line: string, fileName?: string): JobHeader {
  const match = HEADER.exec(line);
  if (!match) {
    return { ok: false, error: 'header must be exactly `#job repo=<repo> lane=<lane> tier=<tier>` with single spaces and lowercase [a-z0-9-]+ fields' };
  }
  const [, repo, lane, tier] = match;
  if (!TIERS.has(tier!)) {
    return { ok: false, error: `tier must be one of fast, mid, work, frontier (got "${tier}")` };
  }
  if (fileName !== undefined && repo === 'phantom' && !PHANTOM_FILE.test(fileName)) {
    return { ok: false, error: `repo=phantom jobs require file name RQ-PHX-<A-Z0-9{3,40}>.md (got "${fileName}")` };
  }
  return { ok: true, repo: repo!, lane: lane!, tier: tier! };
}
