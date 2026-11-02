/**
 * RQ-MR-8-SIZE-CAP — router queue admission lint (offline, pure).
 *
 * One router queue line may produce at most one bounded job: a task that
 * touches more than one top-level area of its repo, or whose declared
 * estimate exceeds the merge volume cap (300 changed lines), can never
 * land under the standing size limits as a single change. This lint
 * rejects such lines and, where the overrun is enumerable, proposes a
 * split into dependency-free children — one child per top-level area,
 * each further sliced so no child carries an estimate over the cap.
 * Children are emitted as independently schedulable READY lines: they
 * share lineage (`parent=`, `part=k/n`) but never a `depends=` edge.
 *
 * Line grammar (the documented status-line shapes; the queue store itself
 * is owned by the host bridge and is absent from this checkout):
 *
 *   - READY RQ-ID (pool=p, tier=t, repo=r, EO 13:50): task text KEY=value
 *   RQ-ID (P1 READY, pool=p, tier=t, repo=r): task text KEY=value
 *
 * Scope is measured two ways and UNIONED — a declared `AREA=` cannot hide
 * paths the task text still mentions:
 *   - declared `AREA=`/`AREAS=` fields (comma list; deeper paths collapse
 *     to their first segment; `*`, `all`, `repo`, `root`, `.` and any
 *     `..` segment are unbounded and always reject);
 *   - repo-relative paths mentioned in the text (`docs/x.md` -> `docs`),
 *     including bare top-level filenames (`AGENTS.md` -> `AGENTS.md`).
 * Estimated size comes only from a declared `EST-LINES=<int>` field; the
 * lint never fabricates one. `EST_LINES` is accepted as an alias.
 *
 * Verdicts per admission line (READY or PROPOSED):
 *   accept  — exactly one top-level area and a declared estimate <= cap.
 *   reject  — `multi-area`, `oversized` and/or `unbounded-scope`.
 *   review  — no cap violation, but the scope, estimate or status is
 *             undeclared/unknown, so admission cannot be proven safe.
 *   skip    — a known non-admission status, or a non-queue line.
 *   invalid — an RQ-shaped line that fails the grammar or carries a
 *             malformed `EST-LINES` value.
 *
 * Split children quote the parent task with out-of-scope area mentions
 * replaced by `[sibling-area]`, so every emitted line is lint-clean under
 * the same union rule — no special-casing for generated text.
 *
 * No queue writes, no clock, no I/O: the bridge applies proposals under
 * its own lock after revalidating. Task text is untrusted data and is
 * never executed, interpolated into commands, or treated as authority.
 */

export const ROUTER_LINT_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  lines: 20_000,
  lineChars: 32_000,
  envelopeChars: 2_000,
  taskChars: 31_000,
  idChars: 184,
  maxAreas: 1,
  maxEstLines: 300,
  maxChildrenPerLine: 8,
  maxEstValue: 1_000_000,
} as const);

export type RouterLineVerdict = 'accept' | 'reject' | 'review' | 'skip' | 'invalid';
export type RouterLintReason =
  | 'multi-area' | 'oversized' | 'unbounded-scope'
  | 'scope-undeclared' | 'estimate-undeclared' | 'status-unknown'
  | 'not-admission' | 'not-a-queue-line' | 'malformed';
export type RouterSplitBlock = 'unbounded-scope' | 'fan-out-too-wide' | 'id-too-long';

export interface RouterLintOptions {
  /** Admission cap on distinct top-level areas per line (default 1). */
  maxAreas?: number;
  /** Admission cap on the declared changed-line estimate (default 300). */
  maxEstLines?: number;
  /** Bound on dependency-free children emitted for one rejected line. */
  maxChildrenPerLine?: number;
}

export interface RouterLineReport {
  /** 1-based line number in the linted text. */
  line: number;
  id: string | null;
  status: string | null;
  verdict: RouterLineVerdict;
  reasons: RouterLintReason[];
  /** Sorted distinct top-level areas (declared union inferred). */
  areas: string[];
  /** Declared changed-line estimate; null when undeclared. */
  estLines: number | null;
}

export interface RouterSplitChild {
  id: string;
  /** Single top-level area the child is scoped to; null for size-only slices. */
  area: string | null;
  estLines: number | null;
  /** `k/n` position among the parent's children. */
  part: string;
  /** Rendered admission line, ready for the bridge to apply verbatim. */
  line: string;
}

export interface RouterLineSplit {
  parent: string;
  /** `- SPLIT-PARENT <id> (<envelope>): children=...` tracking line. */
  parentLine: string | null;
  children: RouterSplitChild[];
  /** Why no split was proposed; null when children were emitted. */
  blocked: RouterSplitBlock | null;
}

export interface RouterLineResult extends RouterLineReport {
  /** Present on `reject` verdicts: the proposal, or why none was possible. */
  split?: RouterLineSplit;
}

export interface RouterLintReport {
  v: 1;
  counts: Record<RouterLineVerdict, number>;
  results: RouterLineResult[];
}

/** Statuses observed in the documented queue line shapes plus JSONL states. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'PROPOSED', 'SPLIT-PARENT', 'LAND',
  'DONE', 'FAILED', 'CANCELLED', 'RUNNING',
]);
/** Only admission candidates are size-capped; every other status skips. */
const ADMISSION_STATUSES: ReadonlySet<string> = new Set(['READY', 'PROPOSED']);
const ID_CHARS = ROUTER_LINT_LIMITS.idChars;
const LINE_RE = new RegExp(
  `^[ \\t]{0,16}(?:-[ \\t]{0,16})?(?:([A-Z][A-Z0-9-]{0,31})[ \\t]+)?` +
  `(RQ-[A-Za-z0-9][A-Za-z0-9:._-]{0,${ID_CHARS - 3}})[ \\t]*` +
  `\\(([^()\\n]{0,${ROUTER_LINT_LIMITS.envelopeChars}})\\)[ \\t]*:[ \\t]*(.{1,${ROUTER_LINT_LIMITS.taskChars}})$`,
);
const FIELD_RE = /\b([A-Za-z][A-Za-z0-9_-]{0,39})[ \t]*=[ \t]*([^\s;]+)/g;
const URL_RE = /https?:\/\/\S+/g;
const PATH_RE = /[A-Za-z0-9_.~+@-]+(?:\/[A-Za-z0-9_.~+@-]+)+/g;
const BARE_FILE_RE = /(?:^|[\s"'`([{<])([A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9]{0,9})+)\b/g;
/** Prose tokens that look like filenames but are not repo paths. */
const BARE_FILE_STOP: ReadonlySet<string> = new Set(['node.js', 'vue.js', 'react.js', 'express.js', 'jquery.js', 'deno.js']);
const UNBOUNDED_AREAS: ReadonlySet<string> = new Set(['*', 'all', 'repo', 'root', '.', '(root)']);
/** First segments that mark a token as a plausible repo-relative path. */
const COMMON_ROOT_DIRS: ReadonlySet<string> = new Set([
  'src', 'app', 'apps', 'docs', 'doc', 'test', 'tests', 'e2e', 'scripts', 'tools',
  'ci', 'contrib', 'examples', 'benchmarks', 'site', 'desktop', 'ecosystem',
  'workplans', 'artifacts', 'bin', 'schema', 'schemas', 'web', 'web-ui', 'ui',
  'api', 'lib', 'libs', 'cmd', 'internal', 'pkg', 'infra', 'deploy', 'config',
  'configs', 'vendor', 'assets', 'public', 'server', 'client', 'node', 'notes',
  '.github', '.devin', '.claude', '.agents', '.ashlr',
]);
const SIBLING_PLACEHOLDER = '[sibling-area]';

interface ParsedLine { statusWord: string | null; id: string; envelope: string; task: string }

function fail(): never { throw new Error('Invalid router lint option'); }

function skip(reason: 'not-admission' | 'not-a-queue-line', line: number,
  id: string | null = null, status: string | null = null): RouterLineResult {
  return { line, id, status, verdict: 'skip', reasons: [reason], areas: [], estLines: null };
}
function invalidLine(line: number, id: string | null = null, status: string | null = null,
  areas: string[] = [], estLines: number | null = null): RouterLineResult {
  return { line, id, status, verdict: 'invalid', reasons: ['malformed'], areas, estLines };
}

function parseLine(text: string): ParsedLine | null {
  const match = LINE_RE.exec(text);
  if (!match) return null;
  return { statusWord: match[1] ?? null, id: match[2]!, envelope: match[3]!, task: match[4]! };
}

function statusOf(parsed: ParsedLine): string | null {
  if (parsed.statusWord !== null) return KNOWN_STATUSES.has(parsed.statusWord) ? parsed.statusWord : null;
  for (const word of parsed.envelope.split(/[,\s]+/)) {
    if (!word.includes('=') && KNOWN_STATUSES.has(word)) return word;
  }
  return null;
}

function fieldsOf(task: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const match of task.matchAll(FIELD_RE)) {
    const key = match[1]!.toLowerCase();
    const list = fields.get(key) ?? [];
    list.push(match[2]!);
    fields.set(key, list);
  }
  return fields;
}

/** `src/core/x` -> `src`, `AGENTS.md` -> itself, `./docs/` -> `docs`. */
function topAreaOf(raw: string): { area: string | null; unbounded: boolean } {
  let value = raw.trim();
  while (value.startsWith('./')) value = value.slice(2);
  if (value.endsWith('/')) value = value.slice(0, -1);
  if (UNBOUNDED_AREAS.has(value.toLowerCase()) || value.split('/').includes('..')) {
    return { area: null, unbounded: true };
  }
  const first = value.split('/')[0]!;
  return { area: first === '' ? null : first, unbounded: false };
}

function declaredAreas(fields: Map<string, string[]>): { areas: Set<string>; unbounded: boolean } {
  const areas = new Set<string>();
  let unbounded = false;
  for (const key of ['area', 'areas'] as const) {
    for (const value of fields.get(key) ?? []) {
      for (const item of value.split(',')) {
        if (item === '') continue;
        const { area, unbounded: bad } = topAreaOf(item);
        if (bad) unbounded = true;
        else if (area !== null) areas.add(area);
      }
    }
  }
  return { areas, unbounded };
}

/** Declared `EST-LINES`/`EST_LINES`; conflicting declarations take the maximum. */
function declaredEstimate(fields: Map<string, string[]>): { estLines: number | null; malformed: boolean } {
  let est: number | null = null;
  for (const key of ['est-lines', 'est_lines'] as const) {
    for (const value of fields.get(key) ?? []) {
      if (!/^\d{1,7}$/.test(value.replace(/,+$/, ''))) return { estLines: null, malformed: true };
      const n = Number(value.replace(/,+$/, ''));
      if (!Number.isSafeInteger(n) || n < 1 || n > ROUTER_LINT_LIMITS.maxEstValue) {
        return { estLines: null, malformed: true };
      }
      est = est === null ? n : Math.max(est, n);
    }
  }
  return { estLines: est, malformed: false };
}

/** A token is a repo path when its first segment is a common root dir, or
 * its last segment carries a file extension. Returns the top-level area. */
function inferredPathArea(token: string): string | null {
  let path = token;
  while (path.startsWith('./')) path = path.slice(2);
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length < 2 || segments.includes('..')) return null;
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  if (!COMMON_ROOT_DIRS.has(first.toLowerCase()) && !/\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(last)) return null;
  return first;
}

/** Repo-relative path mentions -> top-level areas; URLs and k=v fields excluded. */
function inferredAreas(task: string): Set<string> {
  const text = task.replace(URL_RE, ' ').replace(FIELD_RE, ' ');
  const areas = new Set<string>();
  for (const match of text.matchAll(PATH_RE)) {
    const area = inferredPathArea(match[0]!);
    if (area !== null) areas.add(area);
  }
  for (const match of text.matchAll(BARE_FILE_RE)) {
    const name = match[1]!;
    if (!BARE_FILE_STOP.has(name.toLowerCase())) areas.add(name);
  }
  return areas;
}

/** Even slices never exceeding the cap: 301 -> [151,150], 900 -> [300,300,300]. */
function sliceBudgets(est: number, slices: number): number[] {
  const base = Math.floor(est / slices);
  const extra = est - base * slices;
  return Array.from({ length: slices }, (_v, index) => base + (index < extra ? 1 : 0));
}

/**
 * A child may quote the parent task but must not claim the siblings' scope:
 * every path mention whose top-level area is not the child's own area is
 * replaced by `[sibling-area]`, so the emitted line passes the same union
 * scope check as any other line. URLs are shielded while masking.
 */
function maskForeignAreas(task: string, keepArea: string | null): string {
  if (keepArea === null) return task;
  const urls: string[] = [];
  const shielded = task.replace(URL_RE, (url) => {
    urls.push(url);
    return `\uE000RLINTURL${urls.length}\uE000`;
  });
  const masked = shielded
    .replace(PATH_RE, (token) => {
      const area = inferredPathArea(token);
      return area !== null && area !== keepArea ? SIBLING_PLACEHOLDER : token;
    })
    .replace(BARE_FILE_RE, (whole, name: string) => {
      if (BARE_FILE_STOP.has(name.toLowerCase()) || name === keepArea) return whole;
      return `${whole.slice(0, whole.length - name.length)}${SIBLING_PLACEHOLDER}`;
    })
    .replace(/\uE000RLINTURL(\d+)\uE000/g, (_m, index: string) => urls[Number(index) - 1]!);
  return masked;
}

/** Child task: parent's scope/size/dependency/lineage fields are stripped,
 * foreign area mentions masked, then the child's own scope is declared. */
function childTask(parentTask: string, area: string | null, estLines: number | null,
  parentId: string, part: [number, number], slices: number): string {
  const stripped = maskForeignAreas(parentTask, area)
    .replace(/\b(?:AREAS?|EST[-_]LINES|depends|parent|part)[ \t]*=[ \t]*[^\s;]+;?[ \t]*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const sentences = [stripped];
  if (area !== null) {
    sentences.push(`Limit the change to the ${area}/ top-level area; sibling jobs cover the rest.`);
  }
  if (slices > 1) {
    sentences.push(`Implement only slice ${part[0]} of ${part[1]}: a complete, independently mergeable slice that fits the line budget; stop at the slice boundary.`);
  }
  const fields = [
    area !== null ? `AREA=${area}` : null,
    estLines !== null ? `EST-LINES=${estLines}` : null,
    `parent=${parentId}`,
    `part=${part[0]}/${part[1]}`,
  ].filter((field): field is string => field !== null);
  return `${sentences.join(' ')} ${fields.join(' ')}`;
}

function proposeSplit(report: RouterLineReport, id: string, envelope: string, task: string,
  options: Required<RouterLintOptions>): RouterLineSplit {
  const blocked = (reason: RouterSplitBlock): RouterLineSplit =>
    ({ parent: id, parentLine: null, children: [], blocked: reason });
  if (report.reasons.includes('unbounded-scope')) return blocked('unbounded-scope');
  const areas = report.areas.length > 0 ? report.areas : [null];
  const slices = report.estLines !== null && report.estLines > options.maxEstLines
    ? Math.ceil(report.estLines / options.maxEstLines) : 1;
  const total = areas.length * slices;
  if (total > options.maxChildrenPerLine) return blocked('fan-out-too-wide');
  const budgets = report.estLines !== null ? sliceBudgets(report.estLines, slices) : [];
  const children: RouterSplitChild[] = [];
  let index = 0;
  for (const area of areas) {
    for (let slice = 0; slice < slices; slice++) {
      index++;
      const childId = `${id}-C${index}`;
      if (childId.length > ID_CHARS) return blocked('id-too-long');
      const est = report.estLines !== null ? budgets[slice]! : null;
      const text = childTask(task, area, est, id, [index, total], slices);
      children.push({ id: childId, area, estLines: est, part: `${index}/${total}`,
        line: `- READY ${childId} (${envelope}): ${text}` });
    }
  }
  return { parent: id,
    parentLine: `- SPLIT-PARENT ${id} (${envelope}): children=${children.map((child) => child.id).join(',')}`,
    children, blocked: null };
}

function boundedOption(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return Math.min(value, max);
}
function resolveOptions(options: RouterLintOptions): Required<RouterLintOptions> {
  return {
    maxAreas: boundedOption(options.maxAreas, ROUTER_LINT_LIMITS.maxAreas, 64),
    maxEstLines: boundedOption(options.maxEstLines, ROUTER_LINT_LIMITS.maxEstLines, ROUTER_LINT_LIMITS.maxEstValue),
    maxChildrenPerLine: boundedOption(options.maxChildrenPerLine, ROUTER_LINT_LIMITS.maxChildrenPerLine, 64),
  };
}

/** Lint one line; non-admission and non-queue shapes skip without judging. */
export function lintRouterLine(text: string, options: RouterLintOptions = {}, lineNumber = 1): RouterLineResult {
  const opts = resolveOptions(options);
  const line = text.endsWith('\r') ? text.slice(0, -1) : text;
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('<!--') || !trimmed.includes('RQ-')) {
    return skip('not-a-queue-line', lineNumber);
  }
  if (line.length > ROUTER_LINT_LIMITS.lineChars) return invalidLine(lineNumber);
  const parsed = parseLine(line);
  if (parsed === null) return invalidLine(lineNumber);
  const status = statusOf(parsed);
  const fields = fieldsOf(parsed.task);
  const declared = declaredAreas(fields);
  const areas = new Set([...declared.areas, ...inferredAreas(parsed.task)]);
  const sortedAreas = [...areas].sort();
  const { estLines, malformed } = declaredEstimate(fields);
  const base = { line: lineNumber, id: parsed.id, status };
  if (status === null) {
    return { ...base, verdict: 'review', reasons: ['status-unknown'], areas: sortedAreas, estLines };
  }
  if (!ADMISSION_STATUSES.has(status)) {
    return { ...base, verdict: 'skip', reasons: ['not-admission'], areas: sortedAreas, estLines };
  }
  if (parsed.task.includes('\u0000') || parsed.task.includes('\uE000')) {
    return invalidLine(lineNumber, parsed.id, status, sortedAreas, estLines);
  }
  if (malformed) return invalidLine(lineNumber, parsed.id, status, sortedAreas, estLines);
  const reasons: RouterLintReason[] = [];
  if (declared.unbounded) reasons.push('unbounded-scope');
  else if (areas.size > opts.maxAreas) reasons.push('multi-area');
  if (estLines !== null && estLines > opts.maxEstLines) reasons.push('oversized');
  if (reasons.length > 0) {
    const report: RouterLineReport = { line: lineNumber, id: parsed.id, status, verdict: 'reject',
      reasons, areas: sortedAreas, estLines };
    return { ...report, split: proposeSplit(report, parsed.id, parsed.envelope, parsed.task, opts) };
  }
  if (areas.size === 0) reasons.push('scope-undeclared');
  if (estLines === null) reasons.push('estimate-undeclared');
  return { ...base, verdict: reasons.length === 0 ? 'accept' : 'review', reasons, areas: sortedAreas, estLines };
}

/**
 * Lint every line of a candidate queue text. Oversized input fails closed;
 * lines are never concatenated or reordered, and each verdict is independent.
 */
export function lintRouterQueueText(text: string, options: RouterLintOptions = {}): RouterLintReport {
  if (Buffer.byteLength(text) > ROUTER_LINT_LIMITS.inputBytes) {
    throw new Error('Router lint input is too large');
  }
  const lines = text.split('\n');
  if (lines.length > ROUTER_LINT_LIMITS.lines) throw new Error('Too many router lint lines');
  const counts: Record<RouterLineVerdict, number> = { accept: 0, reject: 0, review: 0, skip: 0, invalid: 0 };
  const results = lines.map((line, index) => {
    const result = lintRouterLine(line, options, index + 1);
    counts[result.verdict]++;
    return result;
  });
  return { v: 1, counts, results };
}
