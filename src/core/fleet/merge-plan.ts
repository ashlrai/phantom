import { scrubSecrets } from '../util/scrub.js';

export interface MergePlanPr { number: number; title: string; body: string; isDraft: boolean }
const MAX_PROPOSALS = 100;
const MAX_TEXT_CHARS = 200;

export type ReworkEvidence =
  | 'title-fix' | 'title-rebase' | 'title-recut' | 'title-rebase-batch'
  | 'body-supersedes' | 'body-superseded-by' | 'body-rework' | 'body-handoff';

export interface ReworkEdge {
  /** The open PR carrying the evidence. */
  reworker: number;
  /** The open PR it replaces. */
  origin: number;
  evidence: ReworkEvidence;
}

export type SupersededKind = 'origin' | 'stale-rework';

export interface SupersededProposal {
  number: number;
  /** Bounded and secret-scrubbed — a title is untrusted text. */
  title: string;
  /** The open PR proposed to land instead. */
  supersededBy: number;
  kind: SupersededKind;
  /** The one-line close reason, naming the replacement. */
  reason: string;
  evidence: ReworkEvidence[];
}

const shortName = (repo: string): string => repo.split('/').pop() ?? repo;
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BRIDGE = /^bridge:\s*/i;

/**
 * Title grammars naming the PR an open rework PR replaces. `repo` anchors the
 * `<short>` segment (repo short name, case-insensitive); a null repo accepts
 * every short name — rows already share the snapshot's repo.
 */
function titleOrigins(title: string, repo: string | null): { origin: number; evidence: ReworkEvidence }[] {
  const id = title.replace(BRIDGE, '').trim();
  const anchor = repo === null ? '[A-Za-z0-9._-]+' : escapeRe(shortName(repo));
  const out: { origin: number; evidence: ReworkEvidence }[] = [];
  const fix = new RegExp(`^RQ-FIX-${anchor}-(\\d{1,7})$`, 'i').exec(id);
  if (fix) out.push({ origin: Number(fix[1]), evidence: 'title-fix' });
  const recut = new RegExp(`^RQ-RECUT-${anchor}-(\\d{1,7})-[0-9a-f]{7}$`, 'i').exec(id);
  if (recut) out.push({ origin: Number(recut[1]), evidence: 'title-recut' });
  const batch = new RegExp(`^RQ-REBASE-BATCH-${anchor}-((?:\\d{1,7}-)+\\d{1,7})-[0-9a-f]{6}$`, 'i').exec(id);
  if (batch) {
    for (const member of batch[1]!.split('-')) out.push({ origin: Number(member), evidence: 'title-rebase-batch' });
    return out;
  }
  const rebase = new RegExp(`^RQ-REBASE-${anchor}-(\\d{1,7})(?:-[0-9a-f]{7})?$`, 'i').exec(id);
  if (rebase) out.push({ origin: Number(rebase[1]), evidence: 'title-rebase' });
  return out;
}

/**
 * Explicit supersession claims in a body — the phrases recut/fix bridge PRs
 * actually write ("Supersedes #4588", "recut handoff: PR #3711", "recovery of
 * ashlrai/phantom PR #4348"). Plain `pull/`, `#` and `PR #n` mentions never
 * count: they are as often fetch refs and overlap notes as claims.
 * `direction: 'origin'` — the named PR is what this PR replaces (the common
 * case). `direction: 'reworker'` — the PR claims it is itself replaced
 * ("superseded by #N"), so the named PR is the newer attempt.
 */
function bodyClaims(body: string): { number: number; direction: 'origin' | 'reworker'; evidence: ReworkEvidence }[] {
  const out: { number: number; direction: 'origin' | 'reworker'; evidence: ReworkEvidence }[] = [];
  for (const m of body.matchAll(/\b[Ss]upersedes\s+#(\d{1,7})\b/g)) {
    out.push({ number: Number(m[1]), direction: 'origin', evidence: 'body-supersedes' });
  }
  for (const m of body.matchAll(/\b[Ss]uperseded\s+by\s+#(\d{1,7})\b/g)) {
    out.push({ number: Number(m[1]), direction: 'reworker', evidence: 'body-superseded-by' });
  }
  const rework = /\b(?:[Rr]ecut|[Rr]ework|[Rr]ebase|[Rr]eplaces?|[Rr]ecovery|[Hh]andoff)\b[^\n]{0,80}?\bPR\s+#(\d{1,7})\b/g;
  for (const m of body.matchAll(rework)) {
    const evidence: ReworkEvidence = /handoff/i.test(m[0].slice(0, 20)) ? 'body-handoff' : 'body-rework';
    out.push({ number: Number(m[1]), direction: 'origin', evidence });
  }
  return out;
}

/**
 * Rework edges among OPEN PRs only. A draft reworker carries no evidence — it
 * cannot land. `closedRefs` counts edges whose origin left the open set (a
 * different verb's evidence, never planned here).
 */
export function reworkEdges(prs: readonly MergePlanPr[], repo: string | null): { edges: ReworkEdge[]; closedRefs: number } {
  const open = new Set(prs.map(pr => pr.number));
  const eligible = new Set(prs.filter(pr => !pr.isDraft).map(pr => pr.number));
  const edges: ReworkEdge[] = [];
  let closedRefs = 0;
  for (const pr of prs) {
    if (pr.isDraft) continue;
    for (const found of titleOrigins(pr.title, repo)) {
      if (found.origin === pr.number) continue;
      if (open.has(found.origin)) edges.push({ reworker: pr.number, origin: found.origin, evidence: found.evidence });
      else closedRefs += 1;
    }
    for (const claim of bodyClaims(pr.body)) {
      const edge = claim.direction === 'origin'
        ? { reworker: pr.number, origin: claim.number, evidence: claim.evidence }
        : { reworker: claim.number, origin: pr.number, evidence: claim.evidence };
      if (edge.reworker === edge.origin) continue;
      // The named side must be an open row; a reworker not in the snapshot
      // cannot land and never supersedes.
      if (!eligible.has(edge.reworker) || !open.has(edge.origin)) { closedRefs += 1; continue; }
      edges.push(edge);
    }
  }
  return { edges, closedRefs };
}

/**
 * Edge components → close proposals. Union-find joins reworker→origin edges
 * into families (a rebase of a rebase is one family); the highest-numbered
 * member is the proposed landing PR and every other member is proposed for
 * close with the replacement named — mirroring reworkSuperseded's
 * newest-wins rule for same-origin reworks, except that a member which
 * itself declared "superseded by #n" can never win (its own text says it
 * loses). Bounded to MAX_PROPOSALS rows; `truncated` carries the overflow.
 */
export function supersededOpenPrs(
  prs: readonly MergePlanPr[],
  repo: string | null,
): { proposals: SupersededProposal[]; families: number; edges: number; closedRefs: number; truncated: number } {
  const { edges, closedRefs } = reworkEdges(prs, repo);
  const parent = new Map<number, number>();
  const find = (n: number): number => {
    let root = n;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(n, root);
    return root;
  };
  for (const edge of edges) {
    for (const n of [edge.reworker, edge.origin]) if (!parent.has(n)) parent.set(n, n);
    parent.set(find(edge.reworker), find(edge.origin));
  }
  const families = new Map<number, Set<number>>();
  for (const n of parent.keys()) {
    const root = find(n);
    families.set(root, new Set([...(families.get(root) ?? []), n]));
  }
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  const edgeEvidence = new Map<number, Set<ReworkEvidence>>();
  /** An origin of a 'superseded by #n' edge declared its own replacement. */
  const selfDeclared = new Set<number>();
  const reworkers = new Set<number>();
  for (const e of edges) {
    reworkers.add(e.reworker);
    if (e.evidence === 'body-superseded-by') selfDeclared.add(e.origin);
    for (const n of [e.reworker, e.origin]) {
      edgeEvidence.set(n, new Set([...(edgeEvidence.get(n) ?? []), e.evidence]));
    }
  }
  const proposals: SupersededProposal[] = [];
  let truncated = 0;
  for (const members of families.values()) {
    const eligible = [...members].filter(n => !selfDeclared.has(n) && !byNumber.get(n)?.isDraft);
    if (eligible.length === 0) continue;
    const winner = Math.max(...eligible);
    for (const member of members) {
      if (member === winner) continue;
      const pr = byNumber.get(member);
      if (!pr) continue;
      const kind: SupersededKind = reworkers.has(member) ? 'stale-rework' : 'origin';
      const reason = kind === 'origin'
        ? `Superseded by #${winner}, the open rework PR that replaces this one.`
        : `Superseded by #${winner}, the newer open rework of the same origin.`;
      if (proposals.length >= MAX_PROPOSALS) { truncated += 1; continue; }
      proposals.push({
        number: member,
        title: scrubSecrets(pr.title.slice(0, MAX_TEXT_CHARS)),
        supersededBy: winner,
        kind,
        reason,
        evidence: [...(edgeEvidence.get(member) ?? [])].sort(),
      });
    }
  }
  proposals.sort((a, b) => a.number - b.number);
  return { proposals, families: families.size, edges: edges.length, closedRefs, truncated };
}

// ---------------------------------------------------------------------------
