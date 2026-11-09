import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const SEEDS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-plugin', 'ashlr-stack', 'ashlr-md'];
export interface MergeInput { repo: string; mergedAt: string; title: string; body?: string }
export interface RankRow { repo: string; score: number; weight: number; recency: number; leverage: number }
export interface RankState {
  schemaVersion: 1;
  enrolled: string[];
  weights: { prior: number; recency: number; leverage: number };
  generatedAt: string;
  rankings: RankRow[];
  proposals: RankRow[];
  history: { generatedAt: string; rankings: RankRow[] }[];
}
const surfaces = /\b(?:dispatch|restock|automations|needs-you|comms|cos|radar|friction)\b/i;
export const rankPath = (): string => join(homedir(), '.ashlr', 'repo-rank.json');
function validConfig(value: unknown): value is RankState {
  if (!value || typeof value !== 'object') return false;
  const s = value as RankState;
  return !!s && s.schemaVersion === 1 && Array.isArray(s.enrolled) && s.enrolled.length > 0
    && s.enrolled.every(r => typeof r === 'string' && /^[a-z0-9-]+$/.test(r))
    && new Set(s.enrolled).size === s.enrolled.length
    && !!s.weights && ['prior', 'recency', 'leverage'].every(k => Number.isFinite(s.weights[k as keyof typeof s.weights]) && s.weights[k as keyof typeof s.weights] >= 0)
    && Number.isFinite(s.weights.prior + s.weights.recency + s.weights.leverage)
    && s.weights.prior + s.weights.recency + s.weights.leverage > 0;
}
export function validRank(value: unknown): value is RankState {
  if (!validConfig(value)) return false;
  const s = value;
  return Number.isFinite(Date.parse(s.generatedAt)) && Array.isArray(s.rankings)
    && s.rankings.length === s.enrolled.length && new Set(s.rankings.map(r => r?.repo)).size === s.enrolled.length
    && s.rankings.every(r => !!r && s.enrolled.includes(r.repo) && Number.isFinite(r.weight) && r.weight > 0 && Number.isFinite(r.score))
    && Array.isArray(s.proposals) && Array.isArray(s.history);
}
export function readRank(path = rankPath()): RankState | undefined {
  try { const s: unknown = JSON.parse(readFileSync(path, 'utf8')); return validRank(s) ? s : undefined; } catch { return undefined; }
}
export function computeRank(inputs: MergeInput[], now = new Date(), previous?: RankState): RankState {
  const enrolled = previous?.enrolled ?? [...SEEDS];
  const weights = previous?.weights ?? { prior: 0.5, recency: 0.25, leverage: 0.25 };
  const stats = new Map<string, { recency: number; leverage: number }>();
  for (const input of inputs) {
    const age = (now.getTime() - Date.parse(input.mergedAt)) / 86400000;
    if (!Number.isFinite(age) || age < 0) continue;
    const s = stats.get(input.repo) ?? { recency: 0, leverage: 0 };
    if (age <= 14) s.recency += 2 ** (-age / 7);
    if (surfaces.test(`${input.title}\n${input.body ?? ''}`)) s.leverage++;
    stats.set(input.repo, s);
  }
  const maxRecency = Math.max(1, ...enrolled.map(r => stats.get(r)?.recency ?? 0));
  const maxLeverage = Math.max(1, ...enrolled.map(r => stats.get(r)?.leverage ?? 0));
  const row = (repo: string): RankRow => {
    const s = stats.get(repo) ?? { recency: 0, leverage: 0 };
    const i = SEEDS.indexOf(repo);
    const prior = i < 0 ? 0 : (SEEDS.length - i) / SEEDS.length;
    return { repo, ...s, score: weights.prior * prior + weights.recency * s.recency / maxRecency + weights.leverage * s.leverage / maxLeverage, weight: 0 };
  };
  const compare = (a: RankRow, b: RankRow): number => b.score - a.score || enrolled.indexOf(a.repo) - enrolled.indexOf(b.repo) || a.repo.localeCompare(b.repo);
  const rankings = enrolled.map(row).sort(compare);
  const total = rankings.reduce((n, r) => n + r.score, 0);
  rankings.forEach(r => { r.weight = total ? r.score / total : 1 / rankings.length; });
  if (rankings.length > 1 && rankings[0].weight < 0.4) {
    const rest = 1 - rankings[0].weight;
    rankings.slice(1).forEach(r => { r.weight = r.weight / rest * 0.6; });
    rankings[0].weight = 0.4;
  }
  // Zero evidence must still leave every manually enrolled repository schedulable.
  rankings.forEach(r => { r.weight = Math.max(r.weight, Number.EPSILON); });
  const proposals = [...stats.keys()].filter(r => !enrolled.includes(r) && stats.get(r)!.leverage >= 2).map(row).sort(compare);
  const generatedAt = now.toISOString();
  return { schemaVersion: 1, enrolled, weights, generatedAt, rankings, proposals,
    history: [...(previous?.history ?? []), { generatedAt, rankings }].slice(-30) };
}
export function localMerges(repositories: { repo: string; path: string }[]): MergeInput[] {
  return repositories.flatMap(({ repo, path }) => {
    try {
      let ref: string | undefined;
      for (const candidate of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/master', 'refs/remotes/origin/main', 'refs/heads/master', 'refs/heads/main']) {
        try {
          execFileSync('git', ['-C', path, 'rev-parse', '--verify', candidate], { stdio: 'ignore', timeout: 1000 });
          ref = candidate;
          break;
        } catch { /* Try the next locally available default branch. */ }
      }
      if (!ref) return [];
      const log = execFileSync('git', ['-C', path, 'log', ref, '--first-parent', '--format=%cI%x1f%s%x1f%b%x1e'], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
      return log.split('\x1e').flatMap(record => {
        const [mergedAt, title, body] = record.trim().split('\x1f');
        return title && (/\(#\d+\)/.test(title) || /^Merge pull request #\d+/.test(title)) ? [{ repo, mergedAt, title, body }] : [];
      });
    } catch { return []; }
  });
}
export function updateRank(inputs: () => MergeInput[], options: { path?: string; now?: Date; recompute?: boolean } = {}): RankState {
  const path = options.path ?? rankPath();
  const now = options.now ?? new Date();
  const previous = readRank(path);
  // --recompute requests fresh evidence only after the daily ceiling permits it.
  if (previous && now.getTime() - Date.parse(previous.generatedAt) < 86400000) return previous;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const cached = readRank(path);
      if (cached) return cached;
    }
    throw error;
  }
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const current = readRank(path);
    if (current && now.getTime() - Date.parse(current.generatedAt) < 86400000) return current;
    let config = current;
    if (!config) {
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (validConfig(raw)) config = { ...raw, history: Array.isArray(raw.history) ? raw.history : [] };
      } catch { /* Missing or invalid configuration uses the seed defaults. */ }
    }
    const result = computeRank(inputs(), now, config);
    writeFileSync(temp, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, path);
    return result;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    try { unlinkSync(temp); } catch { /* Rename already removed the temporary file. */ }
  }
}
