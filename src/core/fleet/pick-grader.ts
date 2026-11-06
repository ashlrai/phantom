/**
 * pick-grader.ts — grades each ranker pick 24h and 7d after it was made
 * against the signals it realized (merged, used, stars, installs), nudges the
 * ranker's feature weights toward what happened, and renders pick accuracy
 * for the daily line.
 *
 * The ranker is linear: predicted = clamp01(sum(weight[f] * feature[f])).
 * Realized is a fixed blend of the four signals in [0, 1]. A grade is a "hit"
 * when predicted and realized fall on the same side of 0.5. The weight step
 * is one SGD pass on squared error; the 24h grade moves weights at half the
 * 7d rate because early signals are noisy. Each (pick, window) is graded at
 * most once, so re-running a tick never double-counts.
 *
 * Pure functions plus one small file-backed runner; all paths are injected.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export type GradeWindow = '24h' | '7d';
export const GRADE_WINDOWS: Record<GradeWindow, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};
const RATE: Record<GradeWindow, number> = { '24h': 0.05, '7d': 0.1 };

export interface PickRecord {
  id: string;
  pickedAt: number;
  /** Ranker features, each in [0, 1]. */
  features: Record<string, number>;
}
export interface PickSignals {
  merged: boolean;
  used: boolean;
  stars: number;
  installs: number;
}
export interface PickGrade {
  pickId: string;
  window: GradeWindow;
  gradedAt: number;
  predicted: number;
  realized: number;
  hit: boolean;
  features: Record<string, number>;
}
export type Weights = Record<string, number>;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export function predict(weights: Weights, features: Record<string, number>): number {
  let sum = 0;
  for (const [name, value] of Object.entries(features)) sum += (weights[name] ?? 0) * clamp01(value);
  return clamp01(sum);
}

/** Blend merged/used/stars/installs into [0, 1]; stars and installs saturate. */
export function realizedScore(s: PickSignals): number {
  const stars = Math.log1p(finite(s.stars)) / Math.log1p(100);
  const installs = Math.log1p(finite(s.installs)) / Math.log1p(100);
  return clamp01(0.4 * Number(s.merged) + 0.3 * Number(s.used) + 0.15 * clamp01(stars) + 0.15 * clamp01(installs));
}

/**
 * Grade every pick whose window has elapsed, is not yet graded, and whose
 * signals are readable. `readSignals` returning undefined defers the grade
 * to a later run rather than scoring missing data as zero.
 */
export function gradePicks(
  picks: readonly PickRecord[],
  already: readonly PickGrade[],
  weights: Weights,
  readSignals: (pick: PickRecord, window: GradeWindow) => PickSignals | undefined,
  now: number,
): PickGrade[] {
  const done = new Set(already.map((g) => `${g.pickId}:${g.window}`));
  const out: PickGrade[] = [];
  for (const pick of picks) {
    for (const window of Object.keys(GRADE_WINDOWS) as GradeWindow[]) {
      if (now - pick.pickedAt < GRADE_WINDOWS[window] || done.has(`${pick.id}:${window}`)) continue;
      const signals = readSignals(pick, window);
      if (!signals) continue;
      const predicted = predict(weights, pick.features);
      const realized = realizedScore(signals);
      out.push({
        pickId: pick.id, window, gradedAt: now, predicted, realized,
        hit: predicted >= 0.5 === realized >= 0.5, features: pick.features,
      });
    }
  }
  return out;
}

/** One SGD pass over the new grades; weights stay in [0, 1]. Returns a copy. */
export function updateWeights(weights: Weights, grades: readonly PickGrade[]): Weights {
  const next = { ...weights };
  for (const g of grades) {
    const err = g.realized - predict(next, g.features);
    for (const [name, value] of Object.entries(g.features)) {
      next[name] = clamp01((next[name] ?? 0) + RATE[g.window] * err * clamp01(value));
    }
  }
  return next;
}

/** Daily-line fragment, e.g. `picks 24h 7/10 70% · 7d 3/5 60% · mae 0.21`. */
export function formatPickAccuracyLine(grades: readonly PickGrade[]): string {
  if (grades.length === 0) return 'picks: no graded picks yet';
  const parts = (Object.keys(GRADE_WINDOWS) as GradeWindow[]).flatMap((w) => {
    const rows = grades.filter((g) => g.window === w);
    if (rows.length === 0) return [];
    const hits = rows.filter((g) => g.hit).length;
    return [`${w} ${hits}/${rows.length} ${Math.round((hits / rows.length) * 100)}%`];
  });
  const mae = grades.reduce((a, g) => a + Math.abs(g.predicted - g.realized), 0) / grades.length;
  return `picks ${parts.join(' · ')} · mae ${mae.toFixed(2)}`;
}

export const pickGraderPaths = (home: string) => {
  const dir = join(home, '.ashlr', 'picks');
  return { dir, grades: join(dir, 'grades.jsonl'), weights: join(dir, 'weights.json') };
};

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

function readGrades(path: string): PickGrade[] {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const rows: PickGrade[] = [];
  for (const line of text.split('\n')) {
    try {
      const g = JSON.parse(line) as PickGrade;
      if (g && typeof g.pickId === 'string' && g.window in GRADE_WINDOWS) rows.push(g);
    } catch { /* skip blank or torn line */ }
  }
  return rows;
}

export interface PickGraderRun {
  newGrades: PickGrade[];
  weights: Weights;
  line: string;
}

/** Grade due picks, persist grades + updated weights, return the daily-line text. */
export function runPickGrader(opts: {
  home: string;
  picks: readonly PickRecord[];
  readSignals: (pick: PickRecord, window: GradeWindow) => PickSignals | undefined;
  now: number;
  /** Starting weights when none are saved yet. */
  defaultWeights?: Weights;
}): PickGraderRun {
  const paths = pickGraderPaths(opts.home);
  const prior = readGrades(paths.grades);
  const weights = readJson<Weights>(paths.weights, opts.defaultWeights ?? {});
  const newGrades = gradePicks(opts.picks, prior, weights, opts.readSignals, opts.now);
  const updated = updateWeights(weights, newGrades);
  if (newGrades.length > 0) {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    appendFileSync(paths.grades, newGrades.map((g) => JSON.stringify(g)).join('\n') + '\n', { mode: 0o600 });
    const tmp = `${paths.weights}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated), { mode: 0o600 });
    renameSync(tmp, paths.weights);
  }
  const cutoff = opts.now - GRADE_WINDOWS['7d'];
  const recent = [...prior, ...newGrades].filter((g) => g.gradedAt >= cutoff);
  return { newGrades, weights: updated, line: formatPickAccuracyLine(recent) };
}
