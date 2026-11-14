#!/usr/bin/env node
/* global fetch */
/**
 * Aggregate Phantom ecosystem stats (total GitHub stars + total commits on each
 * default branch) for the repos listed in ecosystem/repos.json.
 *
 * Usage: node scripts/ecosystem-stats.mjs [outDir]   (default: ecosystem-stats-out)
 * Auth:  uses GITHUB_TOKEN if set (the workflow's default token); works unauthenticated.
 * Writes: ecosystem.json, stars.json, commits.json, repos.json (shields.io endpoint badges).
 * Never writes partial data: any failed read exits non-zero.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'ecosystem', 'repos.json'), 'utf8'));
const outDir = resolve(process.argv[2] ?? 'ecosystem-stats-out');

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'phantom-ecosystem-stats' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res;
}

export function lastPage(link) {
  const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(link ?? '');
  return m ? Number(m[1]) : null;
}

async function repoStats(owner, name) {
  const meta = await (await gh(`/repos/${owner}/${name}`)).json();
  const res = await gh(`/repos/${owner}/${name}/commits?sha=${encodeURIComponent(meta.default_branch)}&per_page=1`);
  const page = lastPage(res.headers.get('link'));
  const commits = page ?? (await res.json()).length;
  return {
    repo: meta.name, url: meta.html_url, description: meta.description ?? '',
    stars: meta.stargazers_count, forks: meta.forks_count, commits,
    defaultBranch: meta.default_branch, pushedAt: meta.pushed_at,
  };
}

const fmt = (n) => new Intl.NumberFormat('en-US').format(n);
const badge = (label, message, color) =>
  ({ schemaVersion: 1, label, message, color, labelColor: '0b0b10', namedLogo: 'github', logoColor: 'white' });

async function main() {
  const repos = [];
  for (const name of cfg.repos) repos.push(await repoStats(cfg.owner, name));
  const totals = {
    repos: repos.length,
    stars: repos.reduce((s, r) => s + r.stars, 0),
    commits: repos.reduce((s, r) => s + r.commits, 0),
    forks: repos.reduce((s, r) => s + r.forks, 0),
  };
  const data = {
    schemaVersion: 1, asOf: new Date().toISOString(), owner: cfg.owner,
    scope: 'Sum of GitHub stars and default-branch commits across Phantom ecosystem repos (ecosystem/repos.json).',
    totals, repos,
  };
  mkdirSync(outDir, { recursive: true });
  const w = (f, v) => writeFileSync(join(outDir, f), `${JSON.stringify(v, null, 2)}\n`);
  w('ecosystem.json', data);
  w('stars.json', badge('ecosystem stars', `★ ${fmt(totals.stars)}`, '8b5cf6'));
  w('commits.json', badge('ecosystem commits', fmt(totals.commits), '22c55e'));
  w('repos.json', badge('phantom ecosystem', `${totals.repos} repos`, '0ea5e9'));
  console.log(JSON.stringify(totals));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(String(e)); process.exit(1); });
}
