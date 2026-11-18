/**
 * shipped.ts: the weekly "what shipped" story behind `phm shipped`, the docs
 * page docs/SHIPPED.md and Home's Shipped card. It is a second view of the
 * release notes generator (notes.ts), which already turns commit titles into
 * plain text, folds recuts and marks internal work: this module adds the time
 * window, the product areas and the top line. Merged changes come through an
 * injectable source (local git history by default, a file of merged pull
 * request records for several repositories, a fixture in tests) and
 * `buildShipped` is pure: the same input always gives the same report.
 */
import { execFile } from 'node:child_process';
import { buildReleaseNotes, internal, NOTES_LOG_ARGS, parseNotesLog } from './notes.js';

export const SHIPPED_SCHEMA = 'shipped.v1';
export const SHIPPED_DOC_PATH = 'docs/SHIPPED.md';
export const SHIPPED_MAX_LINES = 8;
const MAX_SENTENCE_CHARS = 140;

/** One merged pull request. `repo` is `owner/name`; without it the change belongs to the one repository being read. */
export interface MergedChange { title: string; number: number | null; mergedAt: string; paths: string[]; repo?: string | null; labels?: string[] }
/** `partial`: some history is missing (a shallow clone). `unknown`: nothing could be read. */
export interface ShippedSourceRead { state: 'ok' | 'partial' | 'unknown'; note: string | null; changes: MergedChange[] }
export type ShippedSource = (sinceMs: number) => ShippedSourceRead | Promise<ShippedSourceRead>;

export type ShippedAreaId = 'desktop' | 'mobile' | 'cli' | 'fleet' | 'channels' | 'plugins' | 'docs' | 'other' | 'unknown';
/** `number` is the newest pull request; `prs` lists every pull request folded into this line, newest first. */
export interface ShippedLine { text: string; number: number | null; mergedAt: string; repo: string | null; prs: number[] }
export interface ShippedArea { id: ShippedAreaId; label: string; count: number; lines: ShippedLine[] }
export interface ShippedReport {
  schema: typeof SHIPPED_SCHEMA;
  version: 1;
  generatedAt: string;
  since: string;
  days: number;
  source: ShippedSourceRead['state'];
  note: string | null;
  /** The `--repo` filter this report was built with, or null for every repository. */
  repo: string | null;
  /** The top line every surface opens with. */
  headline: string;
  /** Repositories with at least one listed change. Null when the source is unknown. */
  repos: number | null;
  /** The listed change that folded the most pull requests, then touched the most files. */
  biggest: string | null;
  /** Null when the source is unknown: nothing was counted, which is not the same as zero. */
  total: number | null;
  maintenance: number | null;
  /** Areas with at least one change, in a fixed order; each holds its newest SHIPPED_MAX_LINES lines. */
  areas: ShippedArea[];
}

const LABELS: Record<ShippedAreaId, string> = {
  desktop: 'Desktop app', mobile: 'Mobile', cli: 'CLI', fleet: 'Fleet', channels: 'Channels', plugins: 'Plugins', docs: 'Docs', other: 'Everything else', unknown: 'Area unknown',
};
/** First match wins, so the narrower prefixes (mobile, channels, plugins, fleet) sit above the wider ones. */
const PREFIXES: Array<[ShippedAreaId, RegExp]> = [
  ['mobile', /^((mobile|ios|android)\/|src\/web-ui\/routes\/verse\/mobile\/|src\/core\/mobile\/|src\/cli\/mobile)/],
  ['desktop', /^(desktop\/|src\/web-ui\/|src\/core\/(verse|desktop|web|visual)\/|src\/cli\/desktop)/],
  ['channels', /^src\/(core\/(comms|comms-agent|connectors)\/|cli\/(comms|channels))/],
  ['plugins', /^(plugins?\/|capabilities\/|src\/core\/(plugins|integrations)\/|src\/(core|cli)\/mcp)/],
  ['fleet', /^(fleet\/|leader\/|queue\/|src\/fleet\/|src\/core\/(fleet|daemon|agents|leader|router|routing|queue|bridge)\/|src\/cli\/(fleet|daemon|jobs|lanes|leader|queue|router))/],
  ['cli', /^(src\/cli\/|bin\/)/],
  ['docs', /^(docs\/|site\/|[^/]+\.md$)/],
];
const areaOfPath = (path: string): ShippedAreaId => PREFIXES.find(([, prefix]) => prefix.test(path))?.[0] ?? 'other';

/** Work in other repositories has paths this map does not know, so a label or the repository's own name can name the area. */
const NAMED: Array<[ShippedAreaId, RegExp]> = [
  ['mobile', /mobile|ios|android/i], ['desktop', /desktop|verse/i], ['plugins', /plugin|mcp/i], ['docs', /\bdoc|website|\bsite\b/i], ['fleet', /fleet|router/i], ['cli', /\bcli\b/i],
];
const named = (names: string[]) => NAMED.find(([, word]) => names.some(name => word.test(name)))?.[0];

/** The area holding most of the change's product paths; ties go to the earlier area. Paths that decide nothing fall back to labels, then the repository name. */
export function areaOf(paths: string[], hint: { repo?: string | null; labels?: string[] } = {}): ShippedAreaId {
  const product = paths.filter(path => !internal(path));
  const counts = new Map<ShippedAreaId, number>();
  for (const path of product) { const area = areaOfPath(path); counts.set(area, (counts.get(area) ?? 0) + 1); }
  const byPath = product.length === 0 ? 'unknown' : (Object.keys(LABELS) as ShippedAreaId[]).reduce((best, area) => (counts.get(area) ?? 0) > (counts.get(best) ?? 0) ? area : best);
  if (byPath !== 'other' && byPath !== 'unknown') return byPath;
  return named(hint.labels ?? []) ?? named(hint.repo ? [hint.repo.replace(/^.*\//, '')] : []) ?? byPath;
}

/** One short sentence from the generator's plain text. */
function sentence(text: string): string {
  const short = text.length > MAX_SENTENCE_CHARS ? `${text.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…` : text;
  return /[.!?…]$/.test(short) ? short : `${short}.`;
}

const NOISE_LABEL = /^(chore|tests?|ci|internal|dependencies|deps|fixup|bot|maintenance|skip-changelog)$/i;
const NOISE_TITLE = /^(?:bridge:\s*)?(?:fixup!|squash!|FIXUP-)/i;
const bare = (title: string) => title.replace(/\s*\(#\d+\)\s*$/, '');
/** `Revert "Revert "X""` is X at depth 2. */
function revertOf(title: string): { base: string; depth: number } {
  let base = bare(title), depth = 0;
  for (let inner; (inner = /^Revert "(.*)"$/.exec(base)); depth++) base = bare(inner[1]!);
  return { base, depth };
}
/** "Live map (part 2)" and "Live map: follow-up" are the same feature as "Live map", so they fold into its line. A bare "step 3" is left alone: it is often the subject. */
const feature = (title: string) => title.replace(/(?:\s*[,:;(-]\s*(?:part|pt|step|phase|take|round)\.?\s*\d+\)?|\s+part\s+\d+|\s*[,:;(-]\s*follow[- ]?ups?\)?)$/i, '').trim() || title;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const repoMatches = (repo: string | null, want: string) => repo !== null && (repo.toLowerCase() === want.toLowerCase() || repo.toLowerCase().endsWith(`/${want.toLowerCase()}`));

export interface ShippedOptions { now: number; days: number; /** `owner/name` or just `name`. */ repo?: string | null; /** Lines kept per area; the website asks for more than a terminal does. */ maxLines?: number }

export function buildShipped(read: ShippedSourceRead, opts: ShippedOptions): ShippedReport {
  const sinceMs = opts.now - opts.days * 86_400_000;
  const window = `the last ${plural(opts.days, 'day')}`;
  const base = {
    schema: SHIPPED_SCHEMA, version: 1, generatedAt: new Date(opts.now).toISOString(), since: new Date(sinceMs).toISOString(),
    days: opts.days, source: read.state, note: read.note, repo: opts.repo ?? null,
  } as const;
  if (read.state === 'unknown') return { ...base, headline: `Unknown: what shipped in ${window} could not be read.`, repos: null, biggest: null, total: null, maintenance: null, areas: [] };
  const inWindow = read.changes
    .filter(change => !opts.repo || repoMatches(change.repo ?? null, opts.repo))
    .map(change => ({ change, at: Date.parse(change.mergedAt), repo: change.repo ?? null }))
    .filter(({ at }) => at >= sinceMs && at <= opts.now)
    .sort((a, b) => b.at - a.at || (b.change.number ?? 0) - (a.change.number ?? 0) || (a.change.title < b.change.title ? -1 : a.change.title > b.change.title ? 1 : 0));
  // Reverts are never listed. The newest revert of a title decides whether the original stands: an odd depth took it back out.
  const undone = new Map<string, boolean>();
  for (const { change, repo } of inWindow) {
    const { base: title, depth } = revertOf(change.title);
    if (depth > 0 && !undone.has(`${repo} ${title}`)) undone.set(`${repo} ${title}`, depth % 2 === 1);
  }
  const noise = (change: MergedChange, repo: string | null) => (change.labels ?? []).some(label => NOISE_LABEL.test(label)) || NOISE_TITLE.test(change.title)
    || revertOf(change.title).depth > 0 || undone.get(`${repo} ${bare(change.title)}`) === true;
  // Newest first, so the generator's own id order is also the display order.
  const id = (index: number) => String(index).padStart(8, '0');
  const kept = inWindow.map((entry, index) => ({ ...entry, index })).filter(({ change, repo }) => !noise(change, repo));
  let maintenance = inWindow.length - kept.length;
  const shipped: Array<{ order: number; weight: number; area: ShippedAreaId; line: ShippedLine }> = [];
  // One pass per repository: pull request numbers, and so recuts, only mean something inside their own repository.
  for (const repo of new Set(kept.map(entry => entry.repo))) {
    const notes = buildReleaseNotes('', '', kept.filter(entry => entry.repo === repo).map(({ change, index }) => ({
      sha: id(index), author: '', files: change.paths, subject: feature(bare(change.title)) + (change.number === null ? '' : ` (#${change.number})`),
    })));
    // Counted after recuts and repeats fold into one change, so the two numbers always add up to the total.
    maintenance += notes.groups.Internal.length;
    for (const entry of [...notes.groups.New, ...notes.groups.Improved, ...notes.groups.Fixed]) {
      const folded = entry.commits.map(sha => inWindow[Number(sha)]!);
      const { change, at } = folded[0]!;
      shipped.push({
        order: Number(entry.commits[0]), area: areaOf(change.paths, change),
        weight: folded.length * 10_000 + Math.min(9_999, folded.reduce((sum, each) => sum + each.change.paths.length, 0)),
        line: { text: sentence(entry.text), number: change.number, mergedAt: new Date(at).toISOString(), repo, prs: folded.flatMap(each => each.change.number ?? []) },
      });
    }
  }
  shipped.sort((a, b) => a.order - b.order);
  const areas = (Object.keys(LABELS) as ShippedAreaId[]).flatMap(area => {
    const lines = shipped.filter(entry => entry.area === area).map(entry => entry.line);
    return lines.length ? [{ id: area, label: LABELS[area], count: lines.length, lines: lines.slice(0, opts.maxLines ?? SHIPPED_MAX_LINES) }] : [];
  });
  const repos = new Set(shipped.map(entry => entry.line.repo)).size;
  const biggest = shipped.reduce<typeof shipped[number] | null>((best, entry) => best === null || entry.weight > best.weight ? entry : best, null)?.line.text.replace(/[.…]$/, '') ?? null;
  const span = opts.days === 7 ? 'This week' : opts.days === 1 ? 'Today' : `Last ${opts.days} days`;
  const headline = inWindow.length === 0 ? `Nothing merged in ${window}.`
    : biggest === null ? `${span}: no user-facing changes.`
      : `${span}: ${plural(shipped.length, 'user-facing change')} across ${plural(repos, 'repo')}; biggest: ${biggest}.`;
  return { ...base, headline, repos, biggest, total: shipped.length + maintenance, maintenance, areas };
}

/** Every pull request behind a line; the repository is named once a report spans more than one. */
function ref(line: ShippedLine, report: ShippedReport): string {
  const numbers = (line.prs.length ? line.prs : line.number === null ? [] : [line.number]).map(number => `#${number}`).join(', ');
  const where = [(report.repos ?? 0) > 1 && line.repo ? line.repo.replace(/^.*\//, '') : '', numbers].filter(Boolean).join(' ');
  return where ? `${line.text} (${where})` : line.text;
}

/** The lines every surface opens with: the top line, what was left out, and any gap in the source. */
export function shippedSummary(report: ShippedReport): string[] {
  const maintenance = report.maintenance ? [`Not listed: ${plural(report.maintenance, 'maintenance change')} (tests, chores, fixups, reverts).`] : [];
  return [report.headline, ...maintenance, ...report.note ? [report.note] : []];
}

export function shippedText(report: ShippedReport): string[] {
  const lines = shippedSummary(report);
  for (const area of report.areas) {
    lines.push('', `${area.label} (${area.count})`, ...area.lines.map(line => `  ${ref(line, report)}`));
    if (area.count > area.lines.length) lines.push(`  and ${area.count - area.lines.length} more`);
  }
  return lines;
}

/** The docs page. The heading and the generated-by note are stable so a daily job can refresh it in place. */
export function shippedMarkdown(report: ShippedReport): string {
  const [headline, ...rest] = shippedSummary(report);
  const out = [
    '# What shipped', '',
    `<!-- generated by phm shipped (${SHIPPED_SCHEMA}); do not edit by hand -->`, '',
    // This paragraph never changes, so indexes that quote a page's opening lines stay stable across refreshes.
    'Merged work in plain words, grouped by product area. Generated by `phm shipped --md`; run it again to refresh this page.', '',
    `Covers the ${plural(report.days, 'day')} ending ${report.generatedAt.slice(0, 10)}. ${headline}`,
    ...rest.flatMap(line => ['', line]),
  ];
  for (const area of report.areas) {
    out.push('', `## ${area.label}`, '', ...area.lines.map(line => `- ${ref(line, report).replace(/([<>[\]|\\])/g, '\\$1')}`));
    if (area.count > area.lines.length) out.push(`- and ${area.count - area.lines.length} more`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Merged pull request records from a file, for the repositories local git cannot see. A JSON list of
 * `{repo, number, title, merged_at, labels, files}`; `mergedAt`, `{name}` labels and `{path}` files are read too.
 */
export function recordsShippedSource(text: string): ShippedSourceRead {
  let raw: unknown = null;
  try { raw = JSON.parse(text); } catch { /* unknown below */ }
  if (!Array.isArray(raw)) return { state: 'unknown', note: 'The merged pull request file is not a JSON list.', changes: [] };
  const names = (list: unknown, key: string): string[] => (Array.isArray(list) ? list : [])
    .map(item => typeof item === 'string' ? item : (item as Record<string, unknown> | null)?.[key]).filter((item): item is string => typeof item === 'string');
  const changes = raw.flatMap((item): MergedChange[] => {
    const record = (item ?? {}) as Record<string, unknown>;
    const mergedAt = record.merged_at ?? record.mergedAt;
    if (typeof record.title !== 'string' || !record.title.trim() || typeof mergedAt !== 'string' || Number.isNaN(Date.parse(mergedAt))) return [];
    return [{
      title: record.title, number: Number.isSafeInteger(record.number) ? record.number as number : null, mergedAt,
      repo: typeof record.repo === 'string' && record.repo ? record.repo : null, labels: names(record.labels, 'name'), paths: names(record.files ?? record.paths, 'path'),
    }];
  });
  const skipped = raw.length - changes.length;
  return skipped ? { state: 'partial', note: `${plural(skipped, 'record')} could not be read and ${skipped === 1 ? 'was' : 'were'} left out.`, changes } : { state: 'ok', note: null, changes };
}

/** Changes on the default branch of the checkout at `root`, read from local git only. Never blocks: the desktop server calls it too. */
export function gitShippedSource(root: string): ShippedSource {
  const git = (args: string[]) => new Promise<string | null>(done => {
    execFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => done(error ? null : stdout));
  });
  return async sinceMs => {
    // Only the last two path parts of the remote address: the owner and the name.
    const repo = /([^/:@]+\/[^/]+?)(?:\.git)?\s*$/.exec(await git(['remote', 'get-url', 'origin']) ?? '')?.[1] ?? null;
    let branch = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
    for (const name of ['master', 'main']) branch ||= await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) === null ? '' : name;
    const range = [branch || 'HEAD', `--since=${new Date(sinceMs).toISOString()}`];
    // showRoot off: a shallow clone's oldest commit would otherwise list every file in the repository as changed.
    const log = await git(['-c', 'log.showRoot=false', 'log', ...NOTES_LOG_ARGS, ...range, '--']);
    const dates = await git(['log', '--first-parent', '--format=%H %cI', ...range, '--']);
    if (log === null || dates === null) return { state: 'unknown', note: 'No git history could be read here.', changes: [] };
    const mergedAt = new Map(dates.split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]));
    const changes = parseNotesLog(log).map(commit => {
      const number = /\(#(\d+)\)\s*$/.exec(commit.subject);
      return { title: commit.subject, number: number ? Number(number[1]) : null, mergedAt: mergedAt.get(commit.sha) ?? '', paths: commit.files, repo };
    });
    return (await git(['rev-parse', '--is-shallow-repository']))?.trim() === 'true'
      ? { state: 'partial', note: 'This checkout has shortened git history, so some changes may be missing.', changes }
      : { state: 'ok', note: null, changes };
  };
}
