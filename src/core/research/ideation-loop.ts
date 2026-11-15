/** Daily frontier work uses the existing queue executor; no new model transport. */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { lintRestockLine } from '../portfolio/restock-lint.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import { dailyUserSchedule } from '../steward/schedule.js';
import { ideationPrompt, ideationQuality, ideationResult, planIdeation, type IdeationSource } from './ideation.js';
import { readResearchFile, writeResearchFile, researchQueueTransaction } from './queue.js';

const path = z.string().refine(s => isAbsolute(s) && /^[\w/ .-]+$/.test(s));
export const ideationConfig = z.object({
  repoRoot: path, reposRoot: path, queue: path, state: path, jobs: path,
  vitals: path, resources: path, research: path, amplify: path.optional(),
  org: z.string().regex(/^[a-zA-Z0-9-]+$/).default('ashlrai'),
}).strict();
type Config = z.infer<typeof ideationConfig>;
type Gh = (args: string[]) => unknown[];
const gh: Gh = args => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })).flat();
const optional = async (file: string, maxBytes?: number) => readResearchFile(file, maxBytes).catch(() => null);
const snapshot = async (name: string, file: string): Promise<IdeationSource> => {
  const data = await optional(file);
  return { name, text: data === null ? null : data.slice(0, 24_000) + (data.length > 24_000 ? '\n[excerpt truncated]' : '') };
};

export function collectIdeationIssues(org: string, read: Gh = gh): IdeationSource {
  try {
    const deadline = Date.now() + 45_000;
    const repos = z.array(z.object({ name: z.string().regex(/^[\w.-]+$/), private: z.boolean() })).max(100).parse(read([`orgs/${org}/repos?per_page=100`]));
    const rows = repos.map(repo => {
      try {
        if (Date.now() >= deadline) throw new Error('issue collection deadline');
        const issues = z.array(z.object({ number: z.number().int(), title: z.string(), pull_request: z.unknown().optional() })).parse(read([`repos/${org}/${repo.name}/issues?state=open&per_page=100`]));
        // Private issue text never enters a model prompt or a strategy artifact.
        const open = issues.filter(i => !i.pull_request);
        return { repo: repo.name, private: repo.private, total: open.length, sampled: Math.min(open.length, 3), issues: open.slice(0, 3).map(i => ({ number: i.number, title: repo.private ? '[private title withheld]' : scrubSecrets(i.title).slice(0, 150) })) };
      } catch { return { repo: repo.name, state: 'unknown' }; }
    });
    return { name: 'Open GitHub issues (all visible org repos; private titles withheld)', text: JSON.stringify(rows) };
  } catch { return { name: 'Open GitHub issues (discovery unavailable or exceeds 100 repos)', text: null }; }
}

async function stopped(home: string): Promise<void> {
  try { await lstat(join(home, '.ashlr', 'KILL')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('fleet stopped');
}

export function ideationSchedule(config: string, phmPath: string, home = homedir(), platform = process.platform) {
  path.parse(config);
  return dailyUserSchedule({ label: 'ai.ashlr.phm.ideation', fileStem: 'phm-ideation', description: 'Daily frontier ideation', minute: 23,
    command: ['fleet', 'ideation', 'tick', '--config', config, '--apply', '--json'], log: join(home, '.ashlr', 'logs', 'ideation.jsonl') }, { phmPath, home, platform });
}

export async function runIdeation(configFile: string, verb: 'tick' | 'complete', options: { apply?: boolean; day?: string; file?: string; now?: Date; home?: string; github?: Gh } = {}) {
  path.parse(configFile);
  const c: Config = ideationConfig.parse(JSON.parse(await readResearchFile(configFile)));
  const now = options.now ?? new Date();
  const day = options.day ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || day > now.toISOString().slice(0, 10)) throw new Error('invalid day');
  const session = `RQ-IDEATION-${day.replaceAll('-', '')}`;
  const requestFile = join(c.state, `${day}.request.json`);
  const receiptFile = join(c.state, `${day}.result.json`);
  const work = async (queue: string) => {
    await stopped(options.home ?? homedir());
    const history: { day: string; ids: string[] }[] = [];
    for (const file of (await readdir(c.state).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).filter(f => /^\d{4}-\d{2}-\d{2}\.result\.json$/.test(f))) {
      history.push(JSON.parse(await readResearchFile(join(c.state, file))));
    }
    const jobs = await optional(c.jobs, 16 * 1024 * 1024);
    const quality = ideationQuality(history.flatMap(r => r.ids), jobs, now);
    const lint = { reposRoot: c.reposRoot };
    if (verb === 'tick') {
      if (queue.match(/\bRQ-IDEATION-\d{8}\b/g)?.includes(session) || jobs?.includes(`"${session}"`) || history.some(r => r.day === day)) return { lines: [], result: { session, status: 'already-scheduled', quality } };
      const sources = await Promise.all([snapshot('Vitals', c.vitals), snapshot('Resources ledger', c.resources), { name: 'Merged PR outcomes (last 24,000 ledger characters)', text: jobs?.slice(-24_000) ?? null }]);
      sources.push(collectIdeationIssues(c.org, options.github));
      const files = (await readdir(c.research).catch(() => [])).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 10);
      for (const file of files) sources.push(await snapshot(`Research: ${file}`, join(c.research, file)));
      sources.push(c.amplify ? await snapshot('AMPLIFY-LOOP', c.amplify) : { name: 'AMPLIFY-LOOP (not configured)', text: null });
      sources.push({ name: 'Router queue (dedup only; last 24,000 characters)', text: queue.slice(-24_000) });
      for (const source of sources) if (source.text) source.text = scrubSecrets(source.text);
      const prompt = scrubSecrets(ideationPrompt(sources, quality, jobs, now));
      const ready = `- READY ${session} (P2, pool=any, tier=frontier, min_tier=frontier, max_cost_class=included, repo=phantom, after none, enq=${Math.floor(now.getTime() / 1000)}): Run the daily founder ideation session from ${requestFile}. Write JSON to ${c.state}/${day}.output.json. Acceptance: phm fleet ideation complete --config '${configFile}' --day ${day} --file '${c.state}/${day}.output.json' --apply --json succeeds. No commit, push or publication; proposals only.`;
      const verdict = lintRestockLine(ready, 1, lint);
      if (!verdict || 'drop' in verdict) throw new Error('ideation session admission refused');
      if (options.apply) {
        await stopped(options.home ?? homedir());
        await mkdir(c.state, { recursive: true, mode: 0o700 });
        if (!await optional(requestFile)) await writeResearchFile(requestFile, JSON.stringify({ day, sources, prompt }));
      }
      return { lines: [ready], result: { session, status: options.apply ? 'scheduled' : 'planned', quality } };
    }
    const request = JSON.parse(await readResearchFile(requestFile)) as { day: string; sources: IdeationSource[] };
    if (request.day !== day || !options.file) throw new Error('missing session or output');
    let raw = ideationResult.parse(JSON.parse(await readResearchFile(options.file)));
    const previous = await optional(receiptFile);
    if (previous && JSON.stringify(JSON.parse(previous).result) !== JSON.stringify(raw)) throw new Error('session already completed with different output');
    if (previous) {
      const ids = JSON.parse(previous).ids as string[];
      if (ids.length) raw = { ...raw, proposals: raw.proposals.filter(p => ids.includes(p.id)) };
    }
    const shipped = [...(jobs ?? '').split('\n'), ...history.filter(r => r.day !== day).flatMap(r => r.ids)];
    const plan = planIdeation(raw, request.sources, queue, shipped, new Date(`${day}T12:00:00Z`), lint);
    if (previous) plan.selected = plan.selected.filter(p => (JSON.parse(previous).ids as string[]).includes(p.id));
    const lines = plan.selected.map(p => p.ready.replace('):', `, max_cost_class=included, enq=${Math.floor(now.getTime() / 1000)}):`));
    if (options.apply) {
      await stopped(options.home ?? homedir());
      // Persist attribution before queueing; retries use identical output and queue dedup.
      const markdown: string = previous ? JSON.parse(previous).markdown : plan.markdown;
      await mkdir(join(c.repoRoot, 'docs', 'strategy'), { recursive: true });
      const strategy = join(c.repoRoot, 'docs', 'strategy', `IDEATION-${day}.md`);
      const existing = await readResearchFile(strategy).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing !== null && existing !== markdown) throw new Error('strategy already exists');
      if (!previous) {
        await writeResearchFile(receiptFile, JSON.stringify({ day, ids: plan.selected.map(p => p.id), result: plan.result, archived: plan.archived, markdown }));
      }
      if (existing === null) await writeResearchFile(strategy, markdown);
    }
    return { lines, result: { session, status: options.apply ? 'completed' : 'planned', quality, selected: plan.selected.map(p => p.id), archived: plan.archived } };
  };
  const result = options.apply ? await researchQueueTransaction<Awaited<ReturnType<typeof work>>['result']>(c.queue, work) : (await work(await readResearchFile(c.queue))).result;
  return { ...result, applied: options.apply === true };
}
