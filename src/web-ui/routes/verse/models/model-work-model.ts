/**
 * routes/verse/models/model-work-model.ts: what each model on the Models board did in the window, from the one
 * report `phm throughput --by model --json` prints (GET /api/verse/fleet/runs/throughput?by=model). A job belongs
 * to the model its launch row names, so the counts are the job record's own and nothing is guessed from a lane.
 *
 * Pure. Three things stay apart: a model the report has no group for did nothing that was recorded (a measured
 * nothing, drawn as an empty line), a report that could not be read leaves every model unknown (hatched), and
 * work whose job record names no model is counted for no row and said in its own sentence.
 */
import type { ThroughputCounts, ThroughputGroup, ThroughputReport } from '../../../../core/fleet/throughput.js';

export const WORK_WINDOWS = [{ value: '24', label: '24 hours' }, { value: '168', label: '7 days' }] as const;
export type WorkWindow = (typeof WORK_WINDOWS)[number]['value'];
/** The most bars a row draws: a 24 hour window is a bar an hour, 7 days a bar per 7 hours. */
export const WORK_COLUMNS = 24;
/** The report's own name for work whose job record names no model. */
const UNNAMED = 'unknown';

export interface WorkColumn { start: string; hours: number; launched: number; merged: number }
export interface ModelWork {
  /** `worked`: the report holds a group for it. `idle`: read, and nothing recorded. `unread` and `reading`: no reading. */
  kind: 'worked' | 'idle' | 'unread' | 'reading';
  totals: ThroughputCounts | null;
  columns: readonly WorkColumn[];
  words: string;
  /** The bars read aloud. */
  spoken: string;
}
export interface WorkBoard {
  state: 'ok' | 'unread' | 'reading';
  /** "24 hours", "7 days". */
  span: string;
  /** Hours one bar covers. */
  columnHours: number;
  /** The most jobs any one bar on the board holds: every row is drawn against it, so rows compare. */
  peak: number;
  line: string;
  /** Work the job record files under no model; null when there is none (or no reading). */
  unnamed: string | null;
  /** Names jobs launched under that no row on the board carries. */
  strangers: { name: string; words: string }[];
  works: ReadonlyMap<string, ModelWork>;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
export const spanWords = (hours: number): string => hours % 24 === 0 && hours > 24 ? `${hours / 24} days` : plural(hours, 'hour', 'hours');
const barWords = (hours: number): string => hours === 1 ? 'hour' : `${hours} hours`;

/** "12 jobs launched, 5 PRs merged, 2 of 10 finished jobs empty". A count the report does not hold is unknown. */
export function workWords(totals: ThroughputCounts): string {
  if (totals.launched === null || totals.merged === null) return 'unknown';
  const parts = [`${plural(totals.launched, 'job', 'jobs')} launched`, `${plural(totals.merged, 'PR', 'PRs')} merged`];
  if (totals.finished !== null && totals.empty !== null) parts.push(totals.finished === 0 ? 'none finished' : `${totals.empty} of ${totals.finished} finished jobs empty`);
  return parts.join(', ');
}

/** The group's hours folded into at most `max` equal bars, oldest first. */
export function workColumns(group: Pick<ThroughputGroup, 'buckets'>, max = WORK_COLUMNS): WorkColumn[] {
  const size = Math.max(1, Math.ceil(group.buckets.length / max));
  const columns: WorkColumn[] = [];
  for (let i = 0; i < group.buckets.length; i += size) {
    const hours = group.buckets.slice(i, i + size);
    columns.push({ start: hours[0]!.start, hours: hours.length, launched: hours.reduce((sum, hour) => sum + (hour.launched ?? 0), 0), merged: hours.reduce((sum, hour) => sum + (hour.merged ?? 0), 0) });
  }
  return columns;
}

const NO_READING = { totals: null, columns: [] } as const;

export interface WorkInputs {
  /** The report as read; null until it answers or when it cannot be read. */
  report: ThroughputReport | null;
  /** True when the read failed (an older server refuses `by=model`). */
  failed: boolean;
  /** The window asked for, in hours. */
  hours: number;
  /** Every model id the board draws. */
  ids: readonly string[];
}

export function workBoard({ report, failed, hours, ids }: WorkInputs): WorkBoard {
  const span = spanWords(report?.hours ?? hours);
  const columnHours = Math.max(1, Math.ceil((report?.hours ?? hours) / WORK_COLUMNS));
  const blank = (kind: 'unread' | 'reading', words: string, line: string): WorkBoard => ({
    state: kind, span, columnHours, peak: 1, line, unnamed: null, strangers: [],
    works: new Map(ids.map(id => [id, { kind, ...NO_READING, words, spoken: `${id}: ${words}` }])),
  });
  if (report === null) {
    return failed ? blank('unread', 'work unknown', `Work in the last ${span} is unknown: the per-model throughput report could not be read.`)
      : blank('reading', 'reading work', `Reading the last ${span} of work.`);
  }
  if (report.metrics !== 'ok') return blank('unread', 'work unknown', `Work in the last ${span} is unknown: the job metrics file could not be read.`);

  const groups = new Map(report.groups.map(group => [group.name, group]));
  const drawn = ids.flatMap(id => groups.has(id) ? [[id, workColumns(groups.get(id)!)] as const] : []);
  const peak = Math.max(1, ...drawn.flatMap(([, columns]) => columns.map(column => column.launched)));
  const works = new Map(ids.map((id): [string, ModelWork] => {
    const group = groups.get(id);
    if (!group) return [id, { kind: 'idle', ...NO_READING, words: `no work recorded in the last ${span}`, spoken: `${id}: no work recorded in the last ${span}` }];
    const columns = workColumns(group);
    const most = Math.max(...columns.map(column => column.launched));
    return [id, {
      kind: 'worked', totals: group.totals, columns, words: workWords(group.totals),
      spoken: `${id} jobs launched over the last ${span}, a bar per ${barWords(columnHours)}: most in one bar ${most}`,
    }];
  }));
  const named = report.groups.filter(group => group.name !== UNNAMED);
  const lost = groups.get(UNNAMED)?.totals ?? null;
  const pieces = [
    lost?.launched ? `${lost.launched} of ${plural(report.totals.launched ?? lost.launched, 'launch', 'launches')}` : '',
    lost?.merged ? `${lost.merged} of ${plural(report.totals.merged ?? lost.merged, 'merged PR', 'merged PRs')}` : '',
  ].filter(Boolean);
  return {
    state: 'ok', span, columnHours, peak, works,
    line: report.groups.length === 0 ? `No job or PR was recorded in the last ${span}.`
      : `Last ${span}: ${workWords(report.totals)}, under ${plural(named.length, 'model name', 'model names')}.`,
    unnamed: pieces.length > 0 ? `No model is named for ${pieces.join(' and ')}, so no row counts them.` : null,
    strangers: named.filter(group => !ids.includes(group.name)).map(group => ({ name: group.name, words: workWords(group.totals) })),
  };
}

/** Jobs launched by a provider's models in the window; null when there is no reading. */
export function launchedBy(board: WorkBoard, ids: readonly string[]): number | null {
  if (board.state !== 'ok') return null;
  return ids.reduce((sum, id) => sum + (board.works.get(id)?.totals?.launched ?? 0), 0);
}

/** A bar's height as a share of the row, with a floor so one job in a busy board is still a mark. */
export const barHeight = (launched: number, peak: number): number => launched <= 0 ? 0 : Math.max(12, Math.round((launched / peak) * 100));
