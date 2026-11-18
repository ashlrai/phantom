/**
 * shipped.ts: the weekly "what shipped" story behind `phm shipped`, the docs
 * page docs/SHIPPED.md and Home's Shipped card. It is a second view of the
 * release notes generator (notes.ts), which already turns commit titles into
 * plain text, folds recuts and marks internal work: this module adds the time
 * window and the product areas. Merged changes come through an injectable
 * source (local git history by default, a fixture in tests) and `buildShipped`
 * is pure: the same input always gives the same report.
 */
import { execFile } from 'node:child_process';
import { buildReleaseNotes, internal, NOTES_LOG_ARGS, parseNotesLog } from './notes.js';

export const SHIPPED_SCHEMA = 'shipped.v1';
export const SHIPPED_DOC_PATH = 'docs/SHIPPED.md';
export const SHIPPED_MAX_LINES = 8;
const MAX_SENTENCE_CHARS = 140;

export interface MergedChange { title: string; number: number | null; mergedAt: string; paths: string[] }
/** `partial`: some history is missing (a shallow clone). `unknown`: nothing could be read. */
export interface ShippedSourceRead { state: 'ok' | 'partial' | 'unknown'; note: string | null; changes: MergedChange[] }
export type ShippedSource = (sinceMs: number) => ShippedSourceRead | Promise<ShippedSourceRead>;

export type ShippedAreaId = 'desktop' | 'cli' | 'fleet' | 'channels' | 'docs' | 'other' | 'unknown';
export interface ShippedLine { text: string; number: number | null; mergedAt: string }
export interface ShippedArea { id: ShippedAreaId; label: string; count: number; lines: ShippedLine[] }
export interface ShippedReport {
  schema: typeof SHIPPED_SCHEMA;
  version: 1;
  generatedAt: string;
  since: string;
  days: number;
  source: ShippedSourceRead['state'];
  note: string | null;
  /** Null when the source is unknown: nothing was counted, which is not the same as zero. */
  total: number | null;
  maintenance: number | null;
  /** Areas with at least one change, in a fixed order; each holds its newest SHIPPED_MAX_LINES lines. */
  areas: ShippedArea[];
}

const LABELS: Record<ShippedAreaId, string> = {
  desktop: 'Desktop app', cli: 'CLI', fleet: 'Fleet', channels: 'Channels', docs: 'Docs', other: 'Everything else', unknown: 'Area unknown',
};
/** First match wins, so the narrower prefixes (channels, fleet) sit above `src/cli/`. */
const PREFIXES: Array<[ShippedAreaId, RegExp]> = [
  ['desktop', /^(desktop\/|src\/web-ui\/|src\/core\/(verse|desktop|web|visual)\/|src\/cli\/desktop)/],
  ['channels', /^src\/(core\/(comms|comms-agent|connectors)\/|cli\/(comms|channels))/],
  ['fleet', /^(fleet\/|leader\/|queue\/|src\/fleet\/|src\/core\/(fleet|daemon|agents|leader|router|routing|queue|bridge)\/|src\/cli\/(fleet|daemon|jobs|lanes|leader|queue|router))/],
  ['cli', /^(src\/cli\/|bin\/)/],
  ['docs', /^(docs\/|site\/|[^/]+\.md$)/],
];
const areaOfPath = (path: string): ShippedAreaId => PREFIXES.find(([, prefix]) => prefix.test(path))?.[0] ?? 'other';

/** The area holding most of the change's product paths; ties go to the earlier area. No paths: unknown. */
export function areaOf(paths: string[]): ShippedAreaId {
  const product = paths.filter(path => !internal(path));
  if (product.length === 0) return 'unknown';
  const counts = new Map<ShippedAreaId, number>();
  for (const path of product) { const area = areaOfPath(path); counts.set(area, (counts.get(area) ?? 0) + 1); }
  return (Object.keys(LABELS) as ShippedAreaId[]).reduce((best, area) => (counts.get(area) ?? 0) > (counts.get(best) ?? 0) ? area : best);
}

/** One short sentence from the generator's plain text. */
function sentence(text: string): string {
  const short = text.length > MAX_SENTENCE_CHARS ? `${text.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…` : text;
  return /[.!?…]$/.test(short) ? short : `${short}.`;
}

export function buildShipped(read: ShippedSourceRead, opts: { now: number; days: number }): ShippedReport {
  const sinceMs = opts.now - opts.days * 86_400_000;
  const base = {
    schema: SHIPPED_SCHEMA, version: 1, generatedAt: new Date(opts.now).toISOString(), since: new Date(sinceMs).toISOString(),
    days: opts.days, source: read.state, note: read.note,
  } as const;
  if (read.state === 'unknown') return { ...base, total: null, maintenance: null, areas: [] };
  const inWindow = read.changes
    .map(change => ({ change, at: Date.parse(change.mergedAt) }))
    .filter(({ at }) => at >= sinceMs && at <= opts.now)
    .sort((a, b) => b.at - a.at || (b.change.number ?? 0) - (a.change.number ?? 0) || (a.change.title < b.change.title ? -1 : a.change.title > b.change.title ? 1 : 0));
  // Newest first, so the generator's own id order is also the display order.
  const id = (index: number) => String(index).padStart(8, '0');
  const notes = buildReleaseNotes('', '', inWindow.map(({ change }, index) => ({
    sha: id(index), author: '', files: change.paths,
    subject: change.title.replace(/\s*\(#\d+\)\s*$/, '') + (change.number === null ? '' : ` (#${change.number})`),
  })));
  const byArea = new Map<ShippedAreaId, ShippedLine[]>();
  const shipped = [...notes.groups.New, ...notes.groups.Improved, ...notes.groups.Fixed].sort((a, b) => a.commits[0]! < b.commits[0]! ? -1 : 1);
  for (const entry of shipped) {
    const { change, at } = inWindow[Number(entry.commits[0])]!;
    const area = areaOf(change.paths);
    byArea.set(area, [...byArea.get(area) ?? [], { text: sentence(entry.text), number: change.number, mergedAt: new Date(at).toISOString() }]);
  }
  const areas = (Object.keys(LABELS) as ShippedAreaId[]).flatMap(area => {
    const lines = byArea.get(area);
    return lines ? [{ id: area, label: LABELS[area], count: lines.length, lines: lines.slice(0, SHIPPED_MAX_LINES) }] : [];
  });
  // Counted after recuts and repeats fold into one change, so the two numbers always add up to the total.
  return { ...base, total: shipped.length + notes.groups.Internal.length, maintenance: notes.groups.Internal.length, areas };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const ref = (line: ShippedLine) => line.number === null ? line.text : `${line.text} (#${line.number})`;

/** The one-line summary every surface opens with. */
export function shippedHeadline(report: ShippedReport): string {
  const window = `the last ${plural(report.days, 'day')}`;
  if (report.total === null) return `Unknown: what shipped in ${window} could not be read.`;
  if (report.total === 0) return `Nothing merged in ${window}.`;
  const shipped = report.total - (report.maintenance ?? 0);
  return `${plural(shipped, 'change')} shipped in ${window}, plus ${plural(report.maintenance ?? 0, 'maintenance change')}.`;
}

export function shippedText(report: ShippedReport): string[] {
  const lines = [shippedHeadline(report)];
  if (report.note) lines.push(report.note);
  for (const area of report.areas) {
    lines.push('', `${area.label} (${area.count})`, ...area.lines.map(line => `  ${ref(line)}`));
    if (area.count > area.lines.length) lines.push(`  and ${area.count - area.lines.length} more`);
  }
  return lines;
}

/** The docs page. The heading and the generated-by note are stable so a daily job can refresh it in place. */
export function shippedMarkdown(report: ShippedReport): string {
  const out = [
    '# What shipped', '',
    `<!-- generated by phm shipped (${SHIPPED_SCHEMA}); do not edit by hand -->`, '',
    // This paragraph never changes, so indexes that quote a page's opening lines stay stable across refreshes.
    'Merged work in plain words, grouped by product area. Generated by `phm shipped --md`; run it again to refresh this page.', '',
    `Covers the ${plural(report.days, 'day')} ending ${report.generatedAt.slice(0, 10)}. ${shippedHeadline(report)}`,
  ];
  if (report.note) out.push('', report.note);
  for (const area of report.areas) {
    out.push('', `## ${area.label}`, '', ...area.lines.map(line => `- ${ref(line).replace(/([<>[\]|\\])/g, '\\$1')}`));
    if (area.count > area.lines.length) out.push(`- and ${area.count - area.lines.length} more`);
  }
  return `${out.join('\n')}\n`;
}

/** Changes on the default branch of the checkout at `root`, read from local git only. Never blocks: the desktop server calls it too. */
export function gitShippedSource(root: string): ShippedSource {
  const git = (args: string[]) => new Promise<string | null>(done => {
    execFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => done(error ? null : stdout));
  });
  return async sinceMs => {
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
      return { title: commit.subject, number: number ? Number(number[1]) : null, mergedAt: mergedAt.get(commit.sha) ?? '', paths: commit.files };
    });
    return (await git(['rev-parse', '--is-shallow-repository']))?.trim() === 'true'
      ? { state: 'partial', note: 'This checkout has shortened git history, so some changes may be missing.', changes }
      : { state: 'ok', note: null, changes };
  };
}
