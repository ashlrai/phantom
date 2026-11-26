import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '../verse/preferences.js';

export const ECOSYSTEM_REPOS = [
  { name: 'phantom', label: 'Phantom', logo: 'phantom-workbench-logo.svg' },
  { name: 'phantom-secrets', label: 'Phantom Secrets', logo: 'phantom-secrets-logo.svg' },
  { name: 'lexicon', label: 'Lexicon', logo: 'lexicon-logo.svg' },
  { name: 'locus', label: 'Locus', logo: 'locus-logo.svg' },
  { name: 'ashlr-stack', label: 'Stack', logo: 'ashlr-stack-logo.svg' },
  { name: 'ashlr-md', label: 'MD', logo: 'ashlr-md-logo.svg' },
  { name: 'binshield', label: 'Bin Shield', logo: 'binshield-logo.svg' },
  { name: 'ashlr-plugin', label: 'Plugin', logo: 'ashlr-plugin-logo.svg' },
  { name: 'morphkit', label: 'Morph Kit', logo: 'morphkit-mark.svg' },
] as const;

export const REPO_PRIORITIES = ['boost', 'normal', 'pause'] as const;
export type RepoPriority = typeof REPO_PRIORITIES[number];

const multiplier = { boost: 1.25, normal: 1, pause: 0 } as const;
const repoPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const priorityDir = () => join(homedir(), '.ashlr', 'repo-priority');

export function canonicalMarketRepo(value: string): string | null {
  const repo = value.toLowerCase();
  if (repoPattern.test(repo)) return repo;
  const known = ECOSYSTEM_REPOS.find((entry) => entry.name === repo);
  return known ? `ashlrai/${known.name}` : null;
}

export function isRepoPriority(value: unknown): value is RepoPriority {
  return REPO_PRIORITIES.some((priority) => value === priority);
}

function priorityPath(repo: string, directory: string): string {
  const name = canonicalMarketRepo(repo);
  if (!name) throw new Error('Use a GitHub owner/name or a known ecosystem repository.');
  return join(directory, name.replace('/', '@'));
}

export function readRepoPriority(repo: string, directory = priorityDir()): RepoPriority {
  try {
    const raw = readFileSync(priorityPath(repo, directory), 'utf8').trim();
    return isRepoPriority(raw) ? raw : 'normal';
  } catch {
    return 'normal';
  }
}

export function setRepoPriority(repo: string, priority: RepoPriority, directory = priorityDir()): void {
  if (!isRepoPriority(priority)) throw new Error('Priority must be boost, normal, or pause.');
  const file = priorityPath(repo, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(file, `${priority}\n`);
}

export interface RepoMarketEvidence {
  repo: string;
  eligible: boolean;
  priority: RepoPriority;
  queueDepth: number | null;
  ciHealth: 'green' | 'red' | 'pending' | null;
  issues: number | null;
  bugs: number | null;
  stars: number | null;
  mergesPerDay: number | null;
}

export function allocateRepos(evidence: readonly RepoMarketEvidence[]) {
  const rows = evidence.map(({ repo, eligible, priority, queueDepth, ciHealth, issues, bugs, stars, mergesPerDay }) => {
    const reasonCodes = ['flat_baseline'];
    let score = 1;
    const add = (code: string, value: number) => {
      if (value > 0) {
        reasonCodes.push(code);
        score += value;
      }
    };
    const bounded = (n: number | null, cap: number) => Math.min(cap, Math.log2(1 + Math.max(0, n ?? 0)) / 5);
    add('default_branch_ci_failing', ciHealth === 'red' ? 1 : 0);
    add('user_bug_backlog', bounded(bugs, 0.8));
    add('open_issue_backlog', bounded(issues, 0.6));
    add('adoption_signal', bounded(stars, 0.5));
    add('ready_work', bounded(queueDepth, 0.5));
    add('recent_green_delivery', ciHealth === 'green' ? bounded(mergesPerDay, 0.6) : 0);
    if (!eligible) reasonCodes.push('not_enrolled');
    if (priority !== 'normal') reasonCodes.push(priority === 'pause' ? 'owner_pause' : 'owner_boost');
    return { repo, score: eligible ? score * multiplier[priority] : 0, share: 0, reasonCodes };
  });
  const total = rows.reduce((sum, row) => sum + row.score, 0);
  for (const row of rows) row.share = total > 0 ? row.score / total : 0;
  return rows.sort((a, b) => b.share - a.share || a.repo.localeCompare(b.repo));
}
