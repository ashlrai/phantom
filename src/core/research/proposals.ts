/**
 * Research loop core: parse a research digest's `## Proposals` section into
 * scored, bounded job proposals with provenance, dedup against queued and
 * shipped work, and run each rendered `- READY` line through the same
 * admission lint the restocker and queuegen use.
 *
 * Pure: no filesystem, network or clock access beyond the injected `now`.
 * Digest text is untrusted data; it is parsed, never executed or interpolated
 * into commands. See docs/RESEARCH-LOOP.md for the grammar.
 */
import { createHash } from 'node:crypto';
import { parseHarnessDigest } from '../learn/harness-digest-reader.js';
import { FLEET_REPOS, lintRestockLine, type RestockLintOptions } from '../portfolio/restock-lint.js';

const JOB_ID = /^RQ-[A-Z0-9][A-Z0-9._-]{0,79}$/;
const SOURCE_REF = /^S\d+$/;
const SOURCES_FIELD = /^sources?=([S\d,\s]+)$/i;
const ATTR_TOKEN = /^([a-z]+)=([^\s]+)$/;
const ACCEPTANCE_FIELD = /^Acceptance:\s*(.*)$/i;
const PROPOSALS_HEADING = /^##\s+Proposals\s*$/;
const SECTION_HEADING = /^##\s/;
const BULLET = /^- /;
const TIERS = new Set(['frontier', 'work', 'mid', 'fast']);
const POOL = /^(?:codex-[a-z0-9-]+|devin|local|claude)$/;
const MAX_TEXT = 400;

export const RESEARCH_DIGEST_DEFAULTS = Object.freeze({ limit: 5, maxLimit: 20, minScore: 2 });
const OVERLAP_THRESHOLD = 0.8;
const CONFIDENCE_WEIGHT = { high: 1.0, medium: 0.6, low: 0.3 } as const;
const EFFORT_PENALTY = { s: 0, m: 0.5, l: 1.0 } as const;
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'in', 'for', 'of', 'and', 'on', 'with', 'add', 'update', 'fix', 'implement', 'into', 'that', 'so', 'when']);

export type ProposalTier = 'frontier' | 'work' | 'mid' | 'fast';
export type ProposalConfidence = keyof typeof CONFIDENCE_WEIGHT;
export type ProposalEffort = keyof typeof EFFORT_PENALTY;

/** A well-formed proposal record after parsing, before scoring/dedup. */
export interface DraftProposal {
  id: string;
  sources: string[];
  repo: string;
  pool: string;
  tier: ProposalTier;
  impact: number;
  effort: ProposalEffort;
  confidence: ProposalConfidence;
  scope: string;
  acceptance: string;
  /** 1-based line number inside the digest file. */
  line: number;
}

export interface ScoredProposal extends DraftProposal {
  score: number;
  priority: 'P1' | 'P2' | 'P3';
  /** The rendered `- READY` queue line. */
  ready: string;
}

export type DropStage = 'parse' | 'score' | 'dedup' | 'lint';

export interface ProposalDrop {
  stage: DropStage;
  /** Digest line for parse drops; 0 when the failure is post-parse. */
  line: number;
  id: string | null;
  reasons: string[];
  /** Where dedup matched: corpus coordinates, never corpus text. */
  match?: { origin: 'queue' | 'shipped' | 'digest'; line: number | null; sha: string };
}

export interface ResearchPlan {
  ok: boolean;
  /** Provenance summary for the digest's S-source records. */
  sources: { total: number; issues: { id: string; code: string }[] };
  /** Parse stage rejection count (proposal bullets only). */
  candidates: number;
  proposals: ScoredProposal[];
  drops: ProposalDrop[];
}

export interface ResearchPlanOptions {
  /** Router-queue markdown used as a dedup corpus. */
  queue?: string;
  /** Landed-evidence lines: merged job ids or titles, one per line. */
  shipped?: readonly string[];
  /** Digest label recorded in `Provenance:` (typically the file basename). */
  digestLabel?: string;
  limit?: number;
  minScore?: number;
  now: Date;
  lint?: RestockLintOptions;
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** Reject control characters, line separators, pipes and em dashes. */
function unsafeText(text: string): boolean {
  return [...text].some(c => c.charCodeAt(0) < 32 || c === '\u007f')
    || /[\u0085\u2014\u2028\u2029|]/.test(text);
}

function parseAttrs(field: string): Record<string, string> | null {
  const attrs: Record<string, string> = {};
  for (const token of field.split(/\s+/).filter(Boolean)) {
    const match = ATTR_TOKEN.exec(token);
    if (!match) return null;
    attrs[match[1]!] = match[2]!;
  }
  return attrs;
}

interface RawFields { id: string; sources: string[]; attrs: Record<string, string>; scope?: string; acceptance?: string }

/** Split a `- ` bullet into pipe fields; classify each. */
function fieldsOf(line: string): { ok: true; fields: RawFields } | { ok: false; reasons: string[] } {
  const parts = line.slice(2).split('|').map(part => part.trim());
  const reasons: string[] = [];
  const id = parts[0] ?? '';
  const raw: RawFields = { id, sources: [], attrs: {} };
  const attrs: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const bare = /^S\d+(?:\s*,\s*S\d+)*$/.exec(part);
    if (bare) { raw.sources.push(...part.split(',').map(s => s.trim())); continue; }
    const named = SOURCES_FIELD.exec(part);
    if (named) { raw.sources.push(...named[1]!.split(',').map(s => s.trim()).filter(Boolean)); continue; }
    const acceptance = ACCEPTANCE_FIELD.exec(part);
    if (acceptance) {
      if (raw.acceptance !== undefined) reasons.push('duplicate-acceptance');
      raw.acceptance = acceptance[1]!.trim();
      continue;
    }
    const parsed = parseAttrs(part);
    if (parsed) { Object.assign(attrs, parsed); continue; }
    if (raw.scope !== undefined) reasons.push('duplicate-scope');
    raw.scope = part;
  }
  raw.attrs = attrs;
  return reasons.length ? { ok: false, reasons } : { ok: true, fields: raw };
}

/** Validate one parsed bullet into a DraftProposal. */
function draftOf(raw: RawFields, line: number): { ok: true; draft: DraftProposal } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!JOB_ID.test(raw.id)) reasons.push('bad-id');
  if (raw.sources.length === 0) reasons.push('missing-sources');
  else for (const ref of raw.sources) if (!SOURCE_REF.test(ref)) reasons.push('bad-source-ref');
  const attrs = raw.attrs;
  for (const key of Object.keys(attrs)) {
    if (!['impact', 'effort', 'confidence', 'repo', 'pool', 'tier'].includes(key)) reasons.push(`bad-attr:${key}`);
  }
  const impact = Number(attrs['impact']);
  if (attrs['impact'] === undefined) reasons.push('missing-attr:impact');
  else if (!/^[1-5]$/.test(attrs['impact'])) reasons.push('bad-attr:impact');
  const effort = attrs['effort'];
  if (effort === undefined) reasons.push('missing-attr:effort');
  else if (!(effort in EFFORT_PENALTY)) reasons.push('bad-attr:effort');
  const confidence = attrs['confidence'];
  if (confidence === undefined) reasons.push('missing-attr:confidence');
  else if (!(confidence in CONFIDENCE_WEIGHT)) reasons.push('bad-attr:confidence');
  const repo = attrs['repo'] ?? 'phantom';
  if (!(FLEET_REPOS as readonly string[]).includes(repo)) reasons.push('bad-attr:repo');
  const pool = attrs['pool'] ?? 'codex-personal';
  if (!POOL.test(pool)) reasons.push('bad-attr:pool');
  const tier = (attrs['tier'] ?? 'work') as ProposalTier;
  if (!TIERS.has(tier)) reasons.push('bad-attr:tier');
  if (raw.scope === undefined || !raw.scope) reasons.push('missing-scope');
  else if (raw.scope.length > MAX_TEXT || unsafeText(raw.scope)) reasons.push('unsafe-scope');
  if (raw.acceptance === undefined || !raw.acceptance) reasons.push('missing-acceptance');
  else if (raw.acceptance.length > MAX_TEXT || unsafeText(raw.acceptance)) reasons.push('unsafe-acceptance');
  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    draft: {
      id: raw.id, sources: [...new Set(raw.sources)], repo, pool, tier,
      impact, effort: effort as ProposalEffort, confidence: confidence as ProposalConfidence,
      scope: raw.scope!, acceptance: raw.acceptance!, line,
    },
  };
}

/**
 * Read the `## Proposals` bullets of a digest. Other sections, including the
 * `## S<n>` source records, are ignored. Malformed bullets become drops.
 */
export function parseResearchProposals(markdown: string): { proposals: DraftProposal[]; drops: ProposalDrop[] } {
  const proposals: DraftProposal[] = [];
  const drops: ProposalDrop[] = [];
  const seen = new Set<string>();
  let inProposals = false;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (SECTION_HEADING.test(line)) { inProposals = PROPOSALS_HEADING.test(line); continue; }
    if (!inProposals || !BULLET.test(line)) continue;
    const fields = fieldsOf(line);
    const lineNumber = index + 1;
    if (!fields.ok) { drops.push({ stage: 'parse', line: lineNumber, id: null, reasons: fields.reasons }); continue; }
    const draft = draftOf(fields.fields, lineNumber);
    if (!draft.ok) {
      drops.push({ stage: 'parse', line: lineNumber, id: JOB_ID.test(fields.fields.id) ? fields.fields.id : null, reasons: draft.reasons });
      continue;
    }
    if (seen.has(draft.draft.id)) {
      drops.push({ stage: 'dedup', line: lineNumber, id: draft.draft.id, reasons: ['duplicate-id'] });
      continue;
    }
    seen.add(draft.draft.id);
    proposals.push(draft.draft);
  }
  return { proposals, drops };
}

/** Deterministic score: impact x confidence weight - effort penalty. */
export function scoreProposal(draft: DraftProposal): number {
  const score = draft.impact * CONFIDENCE_WEIGHT[draft.confidence] - EFFORT_PENALTY[draft.effort];
  return Math.round(score * 10) / 10;
}

/** Priority ladder; digests never mint P0. */
export function priorityForScore(score: number): 'P1' | 'P2' | 'P3' {
  return score >= 4 ? 'P1' : score >= 2 ? 'P2' : 'P3';
}

/** Render a scored proposal as one `- READY` router-queue line. */
export function renderReadyLine(proposal: DraftProposal & { score: number; priority: string }, digestLabel: string): string {
  const provenance = `Provenance: ${digestLabel} ${proposal.sources.join(',')}; score ${proposal.score}.`;
  const attrs = `${proposal.priority}, pool=${proposal.pool}, tier=${proposal.tier}, repo=${proposal.repo}, after none, research-digest`;
  return `- READY ${proposal.id} (${attrs}): ${proposal.scope} Acceptance: ${proposal.acceptance} ${provenance}`;
}

const tokensOf = (text: string): Set<string> =>
  new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length > 1 && !STOPWORDS.has(t)));

interface CorpusLine { origin: 'queue' | 'shipped'; line: number; tokens: Set<string>; sha: string }

function corpusOf(queue: string | undefined, shipped: readonly string[] | undefined): CorpusLine[] {
  const corpus: CorpusLine[] = [];
  const add = (origin: 'queue' | 'shipped', text: string, line: number) =>
    corpus.push({ origin, line, tokens: tokensOf(text), sha: sha(text) });
  for (const [index, line] of (queue ?? '').split('\n').entries()) if (line.trim()) add('queue', line, index + 1);
  for (const [index, line] of (shipped ?? []).entries()) if (line.trim()) add('shipped', line, index + 1);
  return corpus;
}

/** Score, dedup, lint and bound the proposals of one digest into a plan. */
export function planResearchDigest(markdown: string, options: ResearchPlanOptions): ResearchPlan {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? RESEARCH_DIGEST_DEFAULTS.limit), 0), RESEARCH_DIGEST_DEFAULTS.maxLimit);
  const minScore = options.minScore ?? RESEARCH_DIGEST_DEFAULTS.minScore;
  const digest = parseHarnessDigest(markdown, options.now);
  const knownSources = new Set(digest.sources.map(source => source.id));
  const label = options.digestLabel ?? 'digest.md';
  const { proposals: drafts, drops } = parseResearchProposals(markdown);
  const candidates = drafts.length + drops.filter(d => d.stage === 'parse').length;
  const corpus = corpusOf(options.queue, options.shipped);
  const corpusIds = new Set<string>();
  for (const text of [options.queue ?? '', ...(options.shipped ?? [])]) {
    for (const match of text.matchAll(/\bRQ-[A-Z0-9][A-Z0-9._-]*/g)) corpusIds.add(match[0]);
  }

  const admitted: ScoredProposal[] = [];
  const admittedScopes: { id: string; line: number; tokens: Set<string> }[] = [];
  for (const draft of drafts) {
    const drop = (stage: DropStage, reasons: string[], match?: ProposalDrop['match']) =>
      drops.push({ stage, line: draft.line, id: draft.id, reasons, ...(match ? { match } : {}) });
    const missing = draft.sources.filter(ref => !knownSources.has(ref));
    if (missing.length) { drop('parse', [`unknown-source:${missing.join(',')}`]); continue; }
    if (corpusIds.has(draft.id)) { drop('dedup', ['duplicate-id']); continue; }
    const scope = tokensOf(draft.scope);
    const overlap = (tokens: Set<string>) => {
      if (scope.size === 0) return false;
      let shared = 0;
      for (const token of scope) if (tokens.has(token)) shared++;
      return shared / scope.size >= OVERLAP_THRESHOLD;
    };
    const corpusHit = corpus.find(entry => overlap(entry.tokens));
    if (corpusHit) {
      drop('dedup', ['overlap'], { origin: corpusHit.origin, line: corpusHit.line, sha: corpusHit.sha });
      continue;
    }
    const digestHit = admittedScopes.find(entry => overlap(entry.tokens));
    if (digestHit) { drop('dedup', ['overlap'], { origin: 'digest', line: digestHit.line, sha: sha(digestHit.id) }); continue; }

    const score = scoreProposal(draft);
    if (score < minScore) { drop('score', ['below-min-score']); continue; }
    const proposal: ScoredProposal = { ...draft, score, priority: priorityForScore(score), ready: '' };
    proposal.ready = renderReadyLine(proposal, label);
    const verdict = lintRestockLine(proposal.ready, draft.line, options.lint ?? {});
    if (verdict !== null && 'drop' in verdict) { drop('lint', verdict.drop.reasons as string[]); continue; }
    admitted.push(proposal);
    admittedScopes.push({ id: proposal.id, line: proposal.line, tokens: scope });
  }
  admitted.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ok: true,
    sources: { total: digest.sources.length, issues: digest.issues.map(i => ({ id: i.id, code: i.code })) },
    candidates,
    proposals: admitted.slice(0, limit),
    drops,
  };
}

