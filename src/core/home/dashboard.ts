/**
 * The daily home dashboard (`ashlr home`, MCP `ashlr_home`, console Home):
 * what agents shipped, PRs merged, value per dollar / token / second, what is
 * running now and what needs the human. One read-only core for every surface.
 */
import { ECOSYSTEM_OWNER, ECOSYSTEM_REPOS } from '../ecosystem/onboard.js';

export interface HomeMergedPr { repo: string; number: number; title: string; url: string; mergedAt: string; author: string; openSeconds: number }
export interface HomeRun { id: string; goal: string; engine: string; status: 'running' | 'done' | 'aborted' | 'failed'; createdAt: string; updatedAt: string; tokens: number; costUsd: number }
export interface HomeAttention { kind: 'proposal' | 'failed-run' | 'onboarding' | 'source'; title: string; command: string }

export interface HomeSources {
  now(): Date;
  mergedPrs(sinceIso: string): Promise<{ prs: HomeMergedPr[]; error?: string }>;
  runs(): Promise<{ runs: HomeRun[]; error?: string }>;
  pendingProposals(): Promise<{ id: string; title: string }[]>;
  onboardingNext(): Promise<string | null>;
}

export interface HomeDashboardV1 {
  schemaVersion: 1;
  kind: 'ashlr-home';
  generatedAt: string;
  windowHours: number;
  shipped: { mergedPrs: number; byRepo: Record<string, number>; prs: HomeMergedPr[] };
  spend: { costUsd: number; tokens: number; agentSeconds: number; runs: number };
  value: { mergesPerDollar: number | null; mergesPerMillionTokens: number | null; secondsPerMerge: number | null; medianOpenToMergeSeconds: number | null };
  runningNow: HomeRun[];
  needsYou: HomeAttention[];
  empty: boolean;
  warnings: string[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export async function buildHomeDashboard(src: HomeSources, opts: { windowHours?: number } = {}): Promise<HomeDashboardV1> {
  const windowHours = opts.windowHours ?? 24;
  const now = src.now();
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const warnings: string[] = [];
  const [merged, runRead, proposals, next] = await Promise.all([
    src.mergedPrs(since.toISOString()).catch((e: Error) => ({ prs: [], error: e.message })),
    src.runs().catch((e: Error) => ({ runs: [], error: e.message })),
    src.pendingProposals().catch(() => []),
    src.onboardingNext().catch(() => null),
  ]);
  const needsYou: HomeAttention[] = [];
  if (merged.error) { warnings.push(`merged PRs unavailable: ${merged.error}`); needsYou.push({ kind: 'source', title: 'GitHub could not be read, so merged PRs are missing', command: 'gh auth status' }); }
  if (runRead.error) warnings.push(`runs unavailable: ${runRead.error}`);
  const prs = merged.prs.filter((p) => new Date(p.mergedAt) >= since).sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
  const byRepo: Record<string, number> = {};
  for (const p of prs) byRepo[p.repo] = (byRepo[p.repo] ?? 0) + 1;
  const inWindow = runRead.runs.filter((r) => new Date(r.updatedAt) >= since);
  const costUsd = round(inWindow.reduce((a, r) => a + r.costUsd, 0));
  const tokens = inWindow.reduce((a, r) => a + r.tokens, 0);
  const agentSeconds = Math.round(inWindow.reduce((a, r) => a + Math.max(0, (new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 1000), 0));
  const n = prs.length;
  for (const p of proposals) needsYou.push({ kind: 'proposal', title: `Proposal waiting: ${p.title}`, command: `ashlr inbox show ${p.id}` });
  for (const r of inWindow.filter((x) => x.status === 'failed').slice(0, 5)) needsYou.push({ kind: 'failed-run', title: `Run failed: ${r.goal.slice(0, 80)}`, command: `ashlr status ${r.id}` });
  if (next) needsYou.push({ kind: 'onboarding', title: 'Ecosystem autonomy is not fully on', command: next });
  return {
    schemaVersion: 1, kind: 'ashlr-home', generatedAt: now.toISOString(), windowHours,
    shipped: { mergedPrs: n, byRepo, prs },
    spend: { costUsd, tokens, agentSeconds, runs: inWindow.length },
    value: {
      mergesPerDollar: n && costUsd > 0 ? round(n / costUsd) : null,
      mergesPerMillionTokens: n && tokens > 0 ? round(n / (tokens / 1e6)) : null,
      secondsPerMerge: n && agentSeconds > 0 ? Math.round(agentSeconds / n) : null,
      medianOpenToMergeSeconds: median(prs.map((p) => p.openSeconds)),
    },
    runningNow: runRead.runs.filter((r) => r.status === 'running'),
    needsYou,
    empty: n === 0 && inWindow.length === 0 && needsYou.length === 0,
    warnings,
  };
}

/** PURE: parse `gh search prs --json repository,number,title,url,closedAt,createdAt,author`. */
export function parseMergedSearch(stdout: string): HomeMergedPr[] {
  let rows: unknown;
  try { rows = JSON.parse(stdout) as unknown; } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: { repository?: { nameWithOwner?: string; name?: string }; number?: number; title?: string; url?: string; closedAt?: string; createdAt?: string; author?: { login?: string } }) => {
    if (typeof r.number !== 'number' || !r.closedAt) return [];
    return [{ repo: r.repository?.name ?? r.repository?.nameWithOwner ?? '?', number: r.number, title: r.title ?? '', url: r.url ?? '', mergedAt: r.closedAt, author: r.author?.login ?? '?', openSeconds: r.createdAt ? Math.max(0, Math.round((Date.parse(r.closedAt) - Date.parse(r.createdAt)) / 1000)) : 0 }];
  });
}

export const HOME_REPOS = ECOSYSTEM_REPOS.map((r) => `${ECOSYSTEM_OWNER}/${r.name}`);
