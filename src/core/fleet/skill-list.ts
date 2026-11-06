/**
 * skill-list.ts — read-only view of the learned skill-card corpus.
 *
 * `learnFromApplied` (skill-library.ts) writes one signed card per merged
 * proposal; this module only reads. It collapses revisions to the newest card
 * per skillId, scrubs and caps every text field, and reports counts it really
 * measured or the literal 'unknown'. It never verifies or grants authority:
 * `attestationPresent` says a signature field exists, not that it checks out.
 */
import { scrubSecrets } from '../util/scrub.js';
import { readSkillCardCorpus } from './skill-records.js';
import type { SkillCard, SkillCardStatus } from '../types.js';

export const SKILL_LIST_DEFAULT_LIMIT = 50;
export const SKILL_LIST_MAX_LIMIT = 200;
export const SKILL_LIST_TEXT_CAP = 240;

const STATUSES: readonly SkillCardStatus[] = ['candidate', 'verified', 'deprecated', 'revoked'];

export interface SkillListEntry {
  skillId: string;
  revision: number;
  name: string;
  summary: string;
  status: SkillCardStatus;
  source: SkillCard['source'];
  updatedAt: string;
  taskKinds: string[];
  commandKinds: string[];
  verificationPassed: boolean;
  evidenceCount: number | 'unknown';
  proposalId: string | 'unknown';
  attestationPresent: boolean;
}

export interface SkillListReport {
  schemaVersion: 1;
  /** Skills after the status filter, before the limit. */
  matched: number;
  returned: number;
  /** Distinct skills in the corpus. */
  total: number;
  corpus: 'missing' | 'healthy' | 'degraded';
  invalidRows: number | 'unknown';
  skills: SkillListEntry[];
}

export interface SkillListOptions {
  status?: SkillCardStatus;
  limit?: number;
}

export function isSkillCardStatus(value: string): value is SkillCardStatus {
  return (STATUSES as readonly string[]).includes(value);
}

function text(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const clean = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  return (clean || fallback).slice(0, SKILL_LIST_TEXT_CAP);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => text(v)).filter(Boolean).slice(0, 12) : [];
}

function newer(a: SkillCard, b: SkillCard): boolean {
  return a.revision !== b.revision ? a.revision > b.revision : a.ts > b.ts;
}

function entry(card: SkillCard): SkillListEntry {
  const evidence = card.verification?.evidenceCount;
  return {
    skillId: text(card.skillId),
    revision: card.revision,
    name: text(card.name, '(unnamed)'),
    summary: text(card.summary),
    status: card.status,
    source: card.source,
    updatedAt: card.ts,
    taskKinds: strings(card.taskKinds),
    commandKinds: strings(card.commandKinds),
    verificationPassed: card.verification?.passed === true,
    evidenceCount: typeof evidence === 'number' && Number.isSafeInteger(evidence) ? evidence : 'unknown',
    proposalId: card.proposalId ? text(card.proposalId) : 'unknown',
    attestationPresent: typeof card.attestation === 'string' && card.attestation !== '',
  };
}

/** Newest revision per skill, newest first. Pure over the corpus; never throws. */
export function listSkills(opts: SkillListOptions = {}): SkillListReport {
  let corpus: ReturnType<typeof readSkillCardCorpus> | undefined;
  try {
    corpus = readSkillCardCorpus();
  } catch {
    corpus = undefined;
  }
  const latest = new Map<string, SkillCard>();
  for (const card of corpus?.cards ?? []) {
    const old = latest.get(card.skillId);
    if (!old || newer(card, old)) latest.set(card.skillId, card);
  }
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? SKILL_LIST_DEFAULT_LIMIT), 1), SKILL_LIST_MAX_LIMIT);
  const matched = [...latest.values()]
    .filter((card) => !opts.status || card.status === opts.status)
    .sort((a, b) => (a.ts === b.ts ? a.skillId.localeCompare(b.skillId) : a.ts < b.ts ? 1 : -1));
  const skills = matched.slice(0, limit).map(entry);
  return {
    schemaVersion: 1,
    matched: matched.length,
    returned: skills.length,
    total: latest.size,
    corpus: corpus?.sourceState ?? 'degraded',
    invalidRows: corpus ? corpus.invalidRows : 'unknown',
    skills,
  };
}

export function formatSkillList(report: SkillListReport): string {
  if (report.skills.length === 0) {
    return `No skills yet (corpus ${report.corpus}). Skills are written after a verified PR merges.`;
  }
  const lines = [`${report.returned} of ${report.matched} skills (corpus ${report.corpus})`];
  for (const s of report.skills) {
    lines.push(`${s.status.padEnd(10)} ${s.skillId}  r${s.revision}  ${s.name}`);
    if (s.summary) lines.push(`           ${s.summary}`);
  }
  return lines.join('\n');
}
