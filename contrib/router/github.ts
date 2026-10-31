import { Buffer } from 'node:buffer';
import { Config, FileChange, SHA, Check } from './policy.js';
import { run } from './process.js';

export interface Pull {
  number: number; state: string; draft: boolean; merged: boolean; merge_commit_sha: string | null; merged_at: string | null; changed_files: number;
  base: { sha: string; ref: string; repo: { full_name: string; default_branch: string } };
  head: { sha: string; repo: { full_name: string } | null };
}
export interface Snapshot { pull: Pull; files: FileChange[]; diff: string; codeowners: string }
export class GitHub {
  private publicRepos = new Set<string>();
  private revertCommits = new Map<string, Promise<{ commit: { message: string } }[]>>();
  constructor(private config: Config) {}
  async command(args: string[]): Promise<string> { return run(this.config.gh, args, '', this.config.supervisorHome); }
  async read(path: string, accept = 'application/vnd.github+json'): Promise<string> {
    // Public Checks resources require no additional permission, even with a
    // narrow authenticated token. Keep reads on the host to avoid the public
    // unauthenticated rate limit; never add Checks/Actions/Admin token scopes.
    if (!/^repos\/ashlrai\/[a-z0-9-]+(?:[/?].*)?$/.test(path) || /[\r\n#]/.test(path)) throw new Error('invalid-api-path');
    const repo = path.split('/').slice(1, 3).join('/');
    if (!this.config.repos.includes(repo)) throw new Error('repo-not-allowed');
    if (!this.publicRepos.has(repo)) {
      const meta = JSON.parse(await this.command(['api', `repos/${repo}`])) as { private: boolean };
      if (meta.private !== false) throw new Error('public-repo-required');
      this.publicRepos.add(repo);
    }
    return this.command(['api', path, '-H', `Accept: ${accept}`]);
  }
  async api<T>(path: string): Promise<T> { return JSON.parse(await this.read(path)) as T; }
  async pages<T>(path: string, field?: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const raw = await this.api<unknown>(`${path}${path.includes('?') ? '&' : '?'}page=${page}`);
      const values = field ? (raw as Record<string, unknown>)[field] : raw;
      if (!Array.isArray(values)) throw new Error('invalid-pages');
      all.push(...values);
      if (values.length < 100) return all;
    }
    throw new Error('pagination-limit');
  }
  async pull(repo: string, pr: number): Promise<Pull> {
    const p = await this.api<Pull>(`repos/${repo}/pulls/${pr}`);
    if (p.number !== pr || p.base.repo.full_name !== repo || !SHA.test(p.head.sha) || !SHA.test(p.base.sha) ||
        p.base.ref !== p.base.repo.default_branch || p.head.repo?.full_name !== `masonwyatt23/${repo.split('/')[1]}` || p.draft) throw new Error('invalid-pr');
    return p;
  }
  async snapshot(repo: string, pr: number): Promise<Snapshot> {
    const pull = await this.pull(repo, pr);
    if (pull.state !== 'open' || pull.merged) throw new Error('closed-pr');
    const comparison = `repos/${repo}/compare/${pull.base.sha}...${pull.head.sha}`;
    const compared = await this.api<{ files: FileChange[] }>(comparison);
    const files = compared.files;
    if (!Array.isArray(files) || files.length !== pull.changed_files || files.length >= 300) throw new Error('incomplete-diff');
    const diff = await this.read(comparison, 'application/vnd.github.diff');
    // GitHub precedence; use a recursive tree so absence is distinguished from API failure.
    const tree = await this.api<{ truncated: boolean; tree: { path: string }[] }>(`repos/${repo}/git/trees/${pull.base.sha}?recursive=1`);
    if (tree.truncated) throw new Error('incomplete-tree');
    const ownerPath = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find(path => tree.tree.some(f => f.path === path));
    let codeowners = '';
    if (ownerPath) {
      const content = await this.api<{ encoding: string; content: string }>(`repos/${repo}/contents/${ownerPath}?ref=${pull.base.sha}`);
      if (content.encoding !== 'base64') throw new Error('codeowners-unavailable');
      codeowners = Buffer.from(content.content, 'base64').toString('utf8');
    }
    const after = await this.pull(repo, pr);
    if (after.head.sha !== pull.head.sha || after.base.sha !== pull.base.sha) throw new Error('head-moved');
    return { pull, files, diff, codeowners };
  }
  async checks(repo: string, sha: string): Promise<Check[]> {
    const runs = await this.pages<{ name: string; status: string; conclusion: string | null }>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, 'check_runs');
    const statuses = await this.pages<{ context: string; state: string }>(`repos/${repo}/commits/${sha}/statuses?per_page=100`);
    const seen = new Set<string>();
    const result = [...runs.map(c => ({ name: c.name, state: c.status === 'completed' ? c.conclusion ?? 'unknown' : 'pending' })),
      ...statuses.filter(c => { if (seen.has(c.context)) return false; seen.add(c.context); return true; }).map(c => ({ name: c.context, state: c.state }))];
    if (result.some(c => typeof c.name !== 'string' || c.name.length < 1 || c.name.length > 256 || /\p{Cc}/u.test(c.name) ||
        typeof c.state !== 'string' || !/^[a-z_]{1,32}$/.test(c.state))) throw new Error('invalid-check-evidence');
    return result;
  }
  async main(repo: string): Promise<{ sha: string; checks: Check[] }> {
    const meta = await this.api<{ default_branch: string; private: boolean }>(`repos/${repo}`);
    if (meta.private !== false) throw new Error('public-repo-required');
    const commit = await this.api<{ sha: string }>(`repos/${repo}/commits/${encodeURIComponent(meta.default_branch)}`);
    if (!SHA.test(commit.sha)) throw new Error('invalid-main');
    return { sha: commit.sha, checks: await this.checks(repo, commit.sha) };
  }
  async reverted(repo: string, sha: string): Promise<boolean> {
    if (!this.revertCommits.has(repo)) this.revertCommits.set(repo,
      this.pages<{ commit: { message: string } }>(`repos/${repo}/commits?per_page=100&since=${new Date(Date.now() - 30 * 86400000).toISOString()}`));
    const commits = await this.revertCommits.get(repo)!;
    return commits.some(c => c.commit.message.toLowerCase().includes(`this reverts commit ${sha}`));
  }
  async cancel(repo: string, pr: number): Promise<void> { await this.command(['pr', 'merge', String(pr), '--repo', repo, '--disable-auto']); }
  async approve(repo: string, pr: number, sha: string): Promise<void> {
    const identity = JSON.parse(await this.command(['api', 'user'])) as { login: string };
    const author = await this.api<{ user: { login: string } }>(`repos/${repo}/pulls/${pr}`);
    if (!identity.login || !author.user.login || identity.login === author.user.login) throw new Error('distinct-review-identity-required');
    await this.command(['api', `repos/${repo}/pulls/${pr}/reviews`, '-X', 'POST', '-f', 'event=APPROVE', '-f', `commit_id=${sha}`]);
  }
  async enable(repo: string, pr: number, sha: string): Promise<void> {
    await this.command(['pr', 'merge', String(pr), '--repo', repo, '--auto', '--squash', '--match-head-commit', sha]);
  }
}
