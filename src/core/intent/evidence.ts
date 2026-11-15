/**
 * Merge and release evidence for intent directives, adapted from the pure
 * slice of PR #4235's ledger (linkMergedPull, markShipped, carriedKeys).
 * Everything operates on a ledger the caller supplies and a timestamp the
 * caller supplies: no filesystem, network or wall clock. A merged pull moves a
 * directive to `merged` only; `shipped` needs an explicit release note naming
 * the directive's RQ key, and `verified` is never set here.
 */

export type EvidenceStatus =
  | 'proposed' | 'queued' | 'in-progress' | 'merged' | 'shipped' | 'verified' | 'superseded' | 'closed' | 'unknown';

export interface EvidencePull {
  repo: string;
  number: number;
  url?: string;
  state: 'open' | 'merged' | 'closed' | 'unknown';
}

export interface EvidenceRow {
  at: string;
  kind: 'note' | 'pr' | 'release' | 'verification' | 'sweep' | 'import';
  ref: string;
  note?: string;
}

/** Structural subset of IntentItem; any other fields on a record are left untouched. */
export interface EvidenceItem {
  rq: string[];
  prs: EvidencePull[];
  status: EvidenceStatus;
  evidence: EvidenceRow[];
  lastTouchedAt: string;
  updatedAt: string;
}

export interface EvidenceLedger<T extends EvidenceItem = EvidenceItem> {
  items: T[];
}

export interface MergedPullNote {
  repo: string;
  number: number;
  title: string;
  branch?: string;
  url?: string;
  at?: string;
}

export interface ShippedReleaseNote {
  release: string;
  notes?: string;
  rq?: string[];
  at?: string;
}

export class EvidenceError extends Error {}

export const MAX_EVIDENCE = 32;
export const MAX_PRS = 32;
export const MAX_RELEASE_REF = 200;

const RQ_RE = /^RQ-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const RQ_SCAN = /\bRQ-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const OPEN_FOR_MERGE = new Set<EvidenceStatus>(['proposed', 'queued', 'in-progress', 'unknown']);
const OPEN_FOR_SHIP = new Set<EvidenceStatus>(['proposed', 'queued', 'in-progress', 'unknown', 'merged']);

function rqKeysIn(text: string): string[] {
  const found = text.toUpperCase().match(RQ_SCAN) ?? [];
  return [...new Set(found.filter((key) => RQ_RE.test(key)))];
}

function pullKey(pull: Pick<EvidencePull, 'repo' | 'number'>): string {
  return `${pull.repo.toLowerCase()}#${pull.number}`;
}

function timestamp(at: string | undefined): string {
  if (at === undefined || Number.isNaN(Date.parse(at))) throw new EvidenceError('Time must be an ISO timestamp.');
  return at;
}

/**
 * RQ keys carried in `text`: any well-formed RQ key, plus known keys that
 * appear on a non-alphanumeric boundary (so `cursor/RQ-EXAMPLE-1-fix` matches
 * RQ-EXAMPLE-1 but `XRQ-EXAMPLE-12` does not).
 */
export function carriedKeys(text: string, known: readonly string[]): string[] {
  const upper = text.toUpperCase();
  const embedded = known.filter((key) => {
    let from = 0;
    while (from <= upper.length) {
      const at = upper.indexOf(key, from);
      if (at < 0) return false;
      const before = at === 0 ? '' : upper[at - 1] ?? '';
      const after = upper[at + key.length] ?? '';
      if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
      from = at + key.length;
    }
    return false;
  });
  return [...new Set([...rqKeysIn(text), ...embedded])];
}

/** Directives whose RQ keys intersect `keys`, in ledger order. */
export function findByKeys<T extends EvidenceItem>(ledger: EvidenceLedger<T>, keys: readonly string[]): T[] {
  if (keys.length === 0) return [];
  return ledger.items.filter((item) => item.rq.some((key) => keys.includes(key)));
}

function knownKeys(ledger: EvidenceLedger): string[] {
  return [...new Set(ledger.items.flatMap((item) => item.rq))];
}

function pushEvidence(item: EvidenceItem, row: EvidenceRow): void {
  item.evidence = [...item.evidence, row].slice(-MAX_EVIDENCE);
}

function associatePull(item: EvidenceItem, pull: EvidencePull): void {
  const key = pullKey(pull);
  const existing = item.prs.find((row) => pullKey(row) === key);
  if (existing) {
    existing.state = 'merged';
    if (pull.url && !existing.url) existing.url = pull.url;
    return;
  }
  if (item.prs.length < MAX_PRS) item.prs.push({ ...pull });
}

/**
 * Associate a merged pull with every directive whose RQ key appears in the
 * pull title or branch. Open directives become `merged`; shipped, verified,
 * closed and superseded keep their status. Returns the matched items.
 */
export function linkMergedPull<T extends EvidenceItem>(ledger: EvidenceLedger<T>, pull: MergedPullNote, at?: string): T[] {
  if (!REPO_RE.test(pull.repo) || !Number.isSafeInteger(pull.number) || pull.number < 1) {
    throw new EvidenceError('A merged pull needs owner/name and a pull number.');
  }
  const when = timestamp(at ?? pull.at);
  const known = knownKeys(ledger);
  const keys = [...new Set([...carriedKeys(pull.title, known), ...carriedKeys(pull.branch ?? '', known)])];
  const matched = findByKeys(ledger, keys);
  const linked: EvidencePull = {
    repo: pull.repo, number: pull.number, state: 'merged',
    ...(pull.url ? { url: pull.url } : {}),
  };
  for (const item of matched) {
    associatePull(item, linked);
    if (OPEN_FOR_MERGE.has(item.status)) item.status = 'merged';
    pushEvidence(item, { at: when, kind: 'pr', ref: `${pull.repo}#${pull.number}` });
    item.lastTouchedAt = when;
    item.updatedAt = when;
  }
  return matched;
}

/**
 * Record a release against directives it names (explicit `rq` keys or keys in
 * the release notes). Only open or merged directives become `shipped`;
 * verified, closed and superseded keep their status but still gain the
 * release evidence row. Returns the matched items.
 */
export function markShipped<T extends EvidenceItem>(ledger: EvidenceLedger<T>, release: ShippedReleaseNote, at?: string): T[] {
  const when = timestamp(at ?? release.at);
  const releaseId = release.release.replace(/[\r\n]+/g, ' ').trim();
  if (!releaseId || releaseId.length > MAX_RELEASE_REF) {
    throw new EvidenceError(`Release must be 1 to ${MAX_RELEASE_REF} characters.`);
  }
  const known = knownKeys(ledger);
  const keys = [...new Set([
    ...(release.rq ?? []).flatMap((key) => carriedKeys(key, known)),
    ...carriedKeys(release.notes ?? '', known),
  ])];
  const matched = findByKeys(ledger, keys);
  for (const item of matched) {
    if (OPEN_FOR_SHIP.has(item.status)) item.status = 'shipped';
    pushEvidence(item, { at: when, kind: 'release', ref: releaseId });
    item.lastTouchedAt = when;
    item.updatedAt = when;
  }
  return matched;
}
