/** Real read-only sources for buildHomeDashboard. */
import { spawn } from 'node:child_process';
import { HOME_REPOS, parseMergedSearch, type HomeSources } from './dashboard.js';

function gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    let stdout = ''; let stderr = '';
    const t = setTimeout(() => c.kill('SIGTERM'), 30_000);
    c.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    c.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    c.on('error', (e) => { clearTimeout(t); res({ code: 127, stdout, stderr: e.message }); });
    c.on('close', (code) => { clearTimeout(t); res({ code: code ?? 1, stdout, stderr }); });
  });
}

export function realHomeSources(): HomeSources {
  return {
    now: () => new Date(),
    mergedPrs: async (since) => {
      const args = ['search', 'prs', '--merged', `--merged-at=>=${since.slice(0, 19)}`, '--limit', '200', '--json', 'repository,number,title,url,closedAt,createdAt,author', ...HOME_REPOS.flatMap((r) => ['--repo', r])];
      const r = await gh(args);
      return r.code === 0 ? { prs: parseMergedSearch(r.stdout) } : { prs: [], error: r.stderr.trim().split('\n')[0] || `gh exited ${r.code}` };
    },
    runs: async () => {
      const { listRunsDetailed } = await import('../run/orchestrator.js');
      const read = listRunsDetailed({ limit: 500 });
      return {
        runs: read.runs.map((r) => ({ id: r.id, goal: r.goal, engine: r.engine, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, tokens: (r.usage?.tokensIn ?? 0) + (r.usage?.tokensOut ?? 0), costUsd: r.usage?.estCostUsd ?? 0 })),
        ...(read.sourceState === 'degraded' ? { error: 'run history is partially unreadable' } : {}),
      };
    },
    pendingProposals: async () => {
      const { listProposals } = await import('../inbox/store.js');
      return listProposals({ status: 'pending' }).map((p) => ({ id: p.id, title: (p as { title?: string }).title ?? p.id }));
    },
    onboardingNext: async () => {
      const { runEcosystemUp } = await import('../ecosystem/onboard.js');
      const { realEcosystemDeps } = await import('../ecosystem/onboard-deps.js');
      const r = await runEcosystemUp(await realEcosystemDeps({ withGrant: false }), { statusOnly: true });
      return r.ready ? null : r.nextCommand;
    },
  };
}
