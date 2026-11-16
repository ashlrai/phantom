/**
 * routes/verse/fleet-board/review-pick-model.ts — pure model for the
 * "Needs a reviewer" strip: the one open PR no live claim or running worker
 * names, or the honest reason there is none.
 *
 * The body shape of GET /api/verse/fleet/work-board/review-pick
 * (fleet.review-pick.v1, served by src/core/verse/fleet-review-pick-api.ts
 * over src/core/fleet/review-pick.ts) is declared here on purpose — the web
 * bundle must not import src/core. Anything that does not parse is
 * "unavailable": the strip renders nothing rather than guess at ownership,
 * and `owner` is only ever accepted as the literal 'none'.
 */
export const REVIEW_PICK_PATH = '/api/verse/fleet/work-board/review-pick';

const SCHEMA = 'fleet.review-pick.v1';
/** Same owner/name shape the server route validates with. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_TITLE = 120;
const MAX_REASON = 200;
const MAX_HEAD = 200;
const MAX_REPO = 220;
const MAX_AS_OF = 64;
const MAX_SOURCES = 8;
const MAX_SOURCE_NAME = 64;

export interface ReviewPickFound {
  kind: 'pick';
  repo: string;
  pr: number;
  head: string;
  /** First 7 chars of head_sha — the standard short sha. */
  headShort: string;
  title: string;
  asOf: string;
  candidates: number;
  /** github.com pull URL; null when `repo` is not an owner/name shape. */
  prUrl: string | null;
}

export interface ReviewPickNone {
  kind: 'none';
  reason: string;
  asOf: string;
  /** Ownership sources the read could not consult, when the body lists them. */
  unavailable: string[];
}

export type ReviewPickParse = ReviewPickFound | ReviewPickNone | { kind: 'unavailable' };

/** Bounded printable text; null when the value is not a non-empty string. */
function text(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\p{Cc}/gu, ' ').trim();
  if (clean === '') return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Validate an untrusted body. Wrong schema, a non-integer pr, a non-string
 * picked field, or an owner other than 'none' → unavailable, never a guess.
 */
export function parseReviewPickBody(body: unknown): ReviewPickParse {
  if (!body || typeof body !== 'object') return { kind: 'unavailable' };
  const b = body as Record<string, unknown>;
  const asOf = text(b.as_of, MAX_AS_OF);
  const candidates = b.unowned_candidates;
  if (b.schema !== SCHEMA || asOf === null
    || !Number.isSafeInteger(candidates) || (candidates as number) < 0) {
    return { kind: 'unavailable' };
  }

  const source = b.source !== null && typeof b.source === 'object' ? b.source as Record<string, unknown> : null;
  const unavailable = source !== null && Array.isArray(source.unavailable)
    ? source.unavailable.slice(0, MAX_SOURCES).flatMap((s) => {
      const name = text(s, MAX_SOURCE_NAME);
      return name === null ? [] : [name];
    })
    : [];

  if (b.picked === null) {
    return { kind: 'none', reason: text(b.reason, MAX_REASON) ?? 'no reason recorded', asOf, unavailable };
  }
  if (typeof b.picked !== 'object') return { kind: 'unavailable' };
  const p = b.picked as Record<string, unknown>;
  const repo = text(p.repo, MAX_REPO);
  const head = text(p.head, MAX_HEAD);
  const headSha = text(p.head_sha, 80);
  const title = text(p.title, MAX_TITLE);
  if (repo === null || head === null || headSha === null || title === null
    || !Number.isSafeInteger(p.pr) || (p.pr as number) < 1
    || p.owner !== 'none' || typeof p.reason !== 'string') {
    return { kind: 'unavailable' };
  }
  const pr = p.pr as number;
  return {
    kind: 'pick', repo, pr, head, headShort: headSha.slice(0, 7), title, asOf,
    candidates: candidates as number,
    prUrl: REPO_RE.test(repo) ? `https://github.com/${repo}/pull/${pr}` : null,
  };
}
