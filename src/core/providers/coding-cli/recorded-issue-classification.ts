/**
 * Historical projection of recorded issue metadata to a scheduler kind, role and
 * tier floor. Pure: caller-supplied evidence only; no model, classifier, network,
 * env, clock, file, spawn, dispatch, spending or state write.
 * Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * scheduler/drain.ts kindFromText, tierFromShape, roleFromKind, jobsFromIssues.
 * This is recorded source behavior, not an endorsed live model policy, and it
 * never grants merge authority. The recorded shape is supplied by the caller and
 * is never guessed. Divergences are listed in BRIDGE_NOTES.md.
 */

export const RECORDED_ISSUE_CLASSIFICATION_PROVENANCE = Object.freeze({
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourceFile: 'src/core/providers/coding-cli/scheduler/drain.ts',
  sourceFunctions: Object.freeze(['kindFromText', 'tierFromShape', 'roleFromKind', 'jobsFromIssues'] as const),
  basis: 'historical-offline',
} as const);

/** Source enum spellings (scheduler/types.ts JOB_KINDS). */
export const RECORDED_JOB_KINDS = Object.freeze([
  'coding', 'investigation', 'test-fixing', 'research', 'orchestration', 'review', 'merge-decision',
] as const);
export type RecordedJobKind = (typeof RECORDED_JOB_KINDS)[number];
export type RecordedSchedulerRole = 'produce' | 'review' | 'merge' | 'orchestration';
export type RecordedTierFloor = 'cheap' | 'workhorse' | 'frontier';
export type RecordedBand = 'low' | 'medium' | 'high';

export interface RecordedIssueMetadata {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
}

/** Recorded complexity and risk, as classified at the time. Must be supplied. */
export interface RecordedIssueShape {
  complexity: RecordedBand;
  risk: RecordedBand;
}

export interface RecordedIssueEntry {
  issue: RecordedIssueMetadata;
  shape: RecordedIssueShape;
}

export interface RecordedIssueClassification {
  /** `issue-<number>`, as in the source. */
  id: string;
  jobType: RecordedJobKind;
  role: RecordedSchedulerRole;
  minTier: RecordedTierFloor;
}

export interface RecordedIssueClassificationResult {
  provenance: typeof RECORDED_ISSUE_CLASSIFICATION_PROVENANCE;
  /** Always false. A recorded role, including 'merge', grants nothing. */
  grantsMergeAuthority: false;
  /** Same order as the input entries. */
  jobs: readonly Readonly<RecordedIssueClassification>[];
}

const BANDS: readonly string[] = ['low', 'medium', 'high'];

function reject(path: string, what: string): never {
  throw new RangeError(`recorded issue classification: ${path} ${what}`);
}

/** Copy and validate one entry. Each field is read once; errors never echo values. */
function readEntry(raw: unknown, path: string): { number: number; title: string; body: string; labels: string[]; complexity: string; risk: string } {
  if (typeof raw !== 'object' || raw === null) return reject(path, 'must be an object');
  const { issue, shape } = raw as Record<string, unknown>;
  if (typeof issue !== 'object' || issue === null) return reject(`${path}.issue`, 'must be an object');
  if (typeof shape !== 'object' || shape === null) return reject(`${path}.shape`, 'is required (recorded shape is never guessed)');
  const { number, title, body, labels } = issue as Record<string, unknown>;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return reject(`${path}.issue.number`, 'must be a positive safe integer');
  if (typeof title !== 'string') return reject(`${path}.issue.title`, 'must be a string');
  if (typeof body !== 'string') return reject(`${path}.issue.body`, 'must be a string');
  if (!Array.isArray(labels)) return reject(`${path}.issue.labels`, 'must be an array');
  const copy: string[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label: unknown = labels[i];
    if (typeof label !== 'string') return reject(`${path}.issue.labels[${i}]`, 'must be a string');
    copy.push(label);
  }
  const { complexity, risk } = shape as Record<string, unknown>;
  if (typeof complexity !== 'string' || !BANDS.includes(complexity)) return reject(`${path}.shape.complexity`, 'must be low, medium or high');
  if (typeof risk !== 'string' || !BANDS.includes(risk)) return reject(`${path}.shape.risk`, 'must be low, medium or high');
  return { number, title, body, labels: copy, complexity, risk };
}

function isRecordedJobKind(value: string): value is RecordedJobKind {
  return (RECORDED_JOB_KINDS as readonly string[]).includes(value);
}

function kindFromText(labels: readonly string[], title: string, body: string): RecordedJobKind {
  for (const label of labels) {
    const match = /^kind:(.+)$/.exec(label);
    if (match?.[1] && isRecordedJobKind(match[1])) return match[1];
  }
  const text = `${title}\n${body}`;
  if (/\bmerge\b/i.test(text)) return 'merge-decision';
  if (/\breview\b/i.test(text)) return 'review';
  if (/\b(investigate|investigation)\b/i.test(text)) return 'investigation';
  if (/\b(test|failing tests|ci)\b/i.test(text)) return 'test-fixing';
  if (/\bresearch\b/i.test(text)) return 'research';
  if (/\borchestrat/i.test(text)) return 'orchestration';
  return 'coding';
}

function tierFromShape(complexity: string, risk: string, kind: RecordedJobKind): RecordedTierFloor {
  if (kind === 'merge-decision' || complexity === 'high' || risk === 'high') return 'frontier';
  if (complexity === 'low' && risk === 'low') return 'cheap';
  return 'workhorse';
}

function roleFromKind(kind: RecordedJobKind): RecordedSchedulerRole {
  switch (kind) {
    case 'orchestration': return 'orchestration';
    case 'review': return 'review';
    case 'merge-decision': return 'merge';
    case 'coding':
    case 'investigation':
    case 'test-fixing':
    case 'research': return 'produce';
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

/**
 * Project recorded issues to recorded kind, role and tier floor, in input order.
 * Throws RangeError with a fixed, path-based message on malformed input; the
 * message never contains issue text. Inputs are not mutated.
 */
export function classifyRecordedIssues(entries: readonly RecordedIssueEntry[]): RecordedIssueClassificationResult {
  const list: unknown = entries;
  if (!Array.isArray(list)) return reject('entries', 'must be an array');
  const jobs = list.map((raw, i) => {
    const e = readEntry(raw, `entries[${i}]`);
    const jobType = kindFromText(e.labels, e.title, e.body);
    return Object.freeze({
      id: `issue-${e.number}`,
      jobType,
      role: roleFromKind(jobType),
      minTier: tierFromShape(e.complexity, e.risk, jobType),
    });
  });
  return Object.freeze({
    provenance: RECORDED_ISSUE_CLASSIFICATION_PROVENANCE,
    grantsMergeAuthority: false,
    jobs: Object.freeze(jobs),
  });
}

/** Single-issue convenience over classifyRecordedIssues. */
export function classifyRecordedIssue(entry: RecordedIssueEntry): Readonly<RecordedIssueClassification> {
  return classifyRecordedIssues([entry]).jobs[0]!;
}
