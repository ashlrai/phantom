/** Deterministic, read-only repository signals. Unknown is never zero. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);
const missing = 'no source' as const;
type Missing = typeof missing;
type Json = Record<string, unknown>;
function object(text: string): Json {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid source');
  return value as Json;
}
export interface SignalIO {
  run(command: string, args: string[], cwd: string): Promise<string>;
  read(path: string): Promise<string>;
}
const io: SignalIO = {
  async run(command, args, cwd) {
    return (await exec(command, args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
  },
  async read(path) {
    const data = await readFile(path);
    if (data.length > 1024 * 1024) throw new Error('oversize source');
    return data.toString('utf8');
  },
};
const count = (v: unknown): number | Missing => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : missing;
async function attempt<T>(fn: () => Promise<T>): Promise<T | Missing> {
  try { return await fn(); } catch { return missing; }
}
export async function readSignals(root: string, source: SignalIO = io) {
  root = resolve(root);
  const remote = await attempt(() => source.run('git', ['remote', 'get-url', 'origin'], root));
  const repo = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/)?.[1];
  const api = async (path: string): Promise<Json> => object(await source.run('gh', ['api', path], root));
  const metadata = repo ? await attempt(() => api(`repos/${repo}`)) : missing;
  const pkg = await attempt(async () => object(await source.read(resolve(root, 'package.json'))));
  const name = pkg !== missing && typeof pkg.name === 'string' && /^(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg.name) ? pkg.name : null;
  const npm = name ? await attempt(async () => {
    const data = JSON.parse(await source.run('curl', ['--fail', '--silent', '--show-error', '--max-time', '15',
      `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`], root)) as Json;
    return data.package === name && typeof data.start === 'string' && typeof data.end === 'string'
      ? { downloads: count(data.downloads), start: data.start, end: data.end } : missing;
  }) : missing;
  const used = repo ? await attempt(async () => {
    const prs: { number: number; mergeCommit: { oid: string } | null; files: { path: string }[] }[] = JSON.parse(
      await source.run('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '100', '--json', 'number,mergeCommit,files'], root));
    const rows = [];
    for (const pr of prs) {
      if (!pr.mergeCommit || !/^[a-f0-9]{40}$/.test(pr.mergeCommit.oid)) continue;
      await source.run('git', ['merge-base', '--is-ancestor', pr.mergeCommit.oid, 'HEAD'], root);
      const later = new Set((await source.run('git', ['log', '--format=', '--name-only', '--ancestry-path',
        `${pr.mergeCommit.oid}..HEAD`], root)).split('\n').filter(Boolean));
      const touched = pr.files.map(file => file.path).filter(path => later.has(path));
      if (touched.length) rows.push({ pr: pr.number, evidence: 'later touched', files: touched.sort() });
    }
    return rows.sort((a, b) => a.pr - b.pr);
  }) : missing;
  const scoreboard = await attempt(async () => {
    const text = await source.read(resolve(root, 'adoption-scoreboard.tsv'));
    const [header, ...lines] = text.trimEnd().split(/\r?\n/);
    const columns = header.split('\t');
    const index = columns.indexOf('repo');
    if (index < 0 || !repo) return missing;
    const rows = lines.map(line => line.split('\t'));
    if (rows.some(row => row.length !== columns.length)) return missing;
    return { columns, rows: rows.filter(row => row[index] === repo).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  });
  const staticCount = async (file: string, field: string) => attempt(async () => {
    const data = JSON.parse(await source.read(resolve(root, file))) as Json;
    if (!repo || data.repo !== repo) return missing;
    return field === 'revenue' ? (typeof data[field] === 'boolean' ? data[field] : missing) : count(data[field]);
  });
  return {
    schemaVersion: 1, repo: repo ?? missing,
    used: { source: 'GitHub latest 100 merged PRs + local HEAD ancestry; later path touches only', value: used },
    stars: metadata === missing ? missing : count(metadata.stargazers_count),
    forks: metadata === missing ? missing : count(metadata.forks_count),
    npmWeeklyDownloads: npm,
    mcpInstalls: await staticCount('mcp-installs.json', 'installs'),
    adoptionScoreboard: scoreboard,
    revenue: await staticCount('revenue-signals.json', 'revenue'),
  };
}
