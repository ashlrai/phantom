import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { displaySurfaceTarget, evaluateStandingAuthority } from '../authority/effective-config.js';
import type { EffectiveRepoPolicy } from '../authority/types.js';
import { ecosystemBrand } from '../brand/ecosystem.js';
import { canWriteStandingGrantHere } from '../drive/nodes/pool-host.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { parseReadyTsv } from './lane-console.js';
import { repoIdentityOfPath } from './repo-identity.js';
import { allocateRepos, canonicalMarketRepo, ECOSYSTEM_REPOS, readRepoPriority } from './repo-market.js';
import { readSource } from './runs-parked-queue.js';

type RepoFacts = {
  openPrs: number | null;
  issues: number | null;
  bugs: number | null;
  stars: number | null;
  ciHealth: 'green' | 'red' | 'pending' | null;
  mergesPerDay: number | null;
  lastRelease: { tag: string; publishedAt: string } | null;
};
const UNKNOWN: RepoFacts = { openPrs: null, issues: null, bugs: null, stars: null, ciHealth: null, mergesPerDay: null, lastRelease: null };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const CI_STATES: ReadonlyMap<unknown, RepoFacts['ciHealth']> = new Map([
  ['SUCCESS', 'green'], ['FAILURE', 'red'], ['ERROR', 'red'], ['EXPECTED', 'pending'], ['PENDING', 'pending'],
]);

export function parseRepoMarketFacts(value: unknown, repos: readonly string[]): Map<string, RepoFacts> {
  const data = object(object(value).data);
  return new Map(repos.map((repo, i) => {
    const node = object(data[`repo${i}`]);
    if (String(node.nameWithOwner).toLowerCase() !== repo) return [repo, UNKNOWN];
    const release = object(node.latestRelease);
    const target = object(object(node.defaultBranchRef).target);
    return [repo, {
      openPrs: count(object(node.pullRequests).totalCount),
      issues: count(object(node.issues).totalCount),
      bugs: count(object(node.bugs).totalCount),
      stars: count(node.stargazerCount),
      ciHealth: CI_STATES.get(object(target.statusCheckRollup).state) ?? null,
      mergesPerDay: count(object(data[`merges${i}`]).issueCount),
      lastRelease: typeof release.tagName === 'string' && typeof release.publishedAt === 'string'
        && Number.isFinite(Date.parse(release.publishedAt)) ? { tag: release.tagName, publishedAt: release.publishedAt } : null,
    }];
  }));
}

async function fetchRepoFacts(repos: readonly string[], now: number, run: GitRunner): Promise<Map<string, RepoFacts>> {
  const since = new Date(now - 86_400_000).toISOString();
  const query = `{${repos.map((repo, i) => {
    const [owner, name] = repo.split('/');
    return `repo${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) {
      nameWithOwner stargazerCount pullRequests(states:OPEN){totalCount}
      issues(states:OPEN){totalCount} bugs:issues(states:OPEN,labels:["bug"]){totalCount}
      latestRelease{tagName publishedAt} defaultBranchRef{target{... on Commit{statusCheckRollup{state}}}}
    }
    merges${i}:search(type:ISSUE,query:${JSON.stringify(`repo:${repo} is:pr is:merged merged:>=${since}`)}){issueCount}`;
  }).join('\n')}}`;
  try {
    const result = await run('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd: tmpdir(), timeoutMs: 7000, maxStdoutBytes: 256 * 1024 });
    if (result.timedOut || result.truncated) return new Map();
    return parseRepoMarketFacts(JSON.parse(result.stdout), repos);
  } catch {
    return new Map();
  }
}

const root = () => process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
let factsCache: { key: string; at: number; facts: Promise<Map<string, RepoFacts>> } | undefined;

/** router-queue.md is append-mostly Markdown history; same bound the unfed read uses. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

async function readyDepth(runsDir: string): Promise<Map<string, number> | null> {
  const [source, router] = await Promise.all([
    readSource(join(runsDir, 'queue', 'ready.tsv'), 2 * 1024 * 1024, false),
    readSource(join(runsDir, 'queue', 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES, false),
  ]);
  if (source.state !== 'healthy') return null;
  // Spec-less dispatcher rows resolve their lane through the router-queue.md
  // envelope like the market; a row it rejects is dead work, never depth.
  const parsed = parseReadyTsv(source.text, router.state === 'healthy' ? router.text : null);
  const depths = new Map<string, number>();
  const rows = [...parsed.rows.filter(row => row.status === 'READY'), ...parsed.unhintedRows];
  for (const row of rows) {
    const repo = row.repo && canonicalMarketRepo(row.repo);
    if (repo) depths.set(repo, (depths.get(repo) ?? 0) + 1);
  }
  return depths;
}

function scope() {
  const enrollment = readEnrollmentRegistry();
  const enrolled = new Set(enrollment.state === 'ready'
    ? enrollment.repos.map(path => repoIdentityOfPath(path)?.toLowerCase()).filter((repo): repo is string => !!repo)
    : []);
  const evaluation = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
  const grant = evaluation.grant;
  return { enrollment, enrolled, grant, effectiveRepos: evaluation.policy?.repos ?? [] };
}

export function managedRepoCatalog(enrolled: ReadonlySet<string>, effectiveRepos: readonly Pick<EffectiveRepoPolicy, 'nameWithOwner' | 'stage'>[]) {
  const stages = new Map(effectiveRepos.map(({ nameWithOwner, stage }) => [nameWithOwner.toLowerCase(), stage]));
  const ecosystem = new Map<string, { label: string; logo: string }>(
    ECOSYSTEM_REPOS.map(({ name, label, logo }) => [`ashlrai/${name}`, { label, logo }]),
  );
  return new Map([...new Set([...ecosystem.keys(), ...enrolled, ...stages.keys()])].flatMap(repo => {
    if (!canonicalMarketRepo(repo)) return [];
    const [owner, name] = repo.split('/') as [string, string];
    const brand = ecosystem.get(repo) ?? (owner === 'ashlrai' ? ecosystemBrand(name) : undefined);
    return [[repo, { label: brand?.label ?? name, logo: brand?.logo ?? null, grantStage: stages.get(repo) ?? null }]] as const;
  }));
}

export async function listManagedRepos(opts: { runsDir?: string; now?: number; run?: GitRunner } = {}) {
  const now = opts.now ?? Date.now();
  const { enrollment, enrolled, effectiveRepos } = scope();
  const catalog = managedRepoCatalog(enrolled, effectiveRepos);
  const names = [...catalog.keys()];
  const key = names.join(',');
  const read = () => fetchRepoFacts(names, now, opts.run ?? defaultGitRunner);
  if (!opts.run && (!factsCache || factsCache.key !== key || now - factsCache.at >= 300_000 || now < factsCache.at)) {
    factsCache = { key, at: now, facts: read() };
  }
  const runsDir = opts.runsDir ?? root();
  const [depth, facts, published, freshnessSource] = await Promise.all([
    readyDepth(runsDir), opts.run ? read() : factsCache!.facts,
    readSource(join(runsDir, 'queue', 'repo-shares.json'), 256 * 1024, false),
    readSource(join(runsDir, 'queue', 'repo-freshness.json'), 256 * 1024, false),
  ]);
  let receipt: Record<string, unknown> = {};
  if (published.state === 'healthy') {
    try {
      const snapshot = object(JSON.parse(published.text));
      const age = typeof snapshot.at === 'number' ? now - snapshot.at * 1000 : Infinity;
      if (age >= 0 && age <= 300_000) receipt = object(snapshot.repos);
    } catch { /* An unreadable queue receipt is not an allocation decision. */ }
  }
  const evidence = names.map(repo => ({
    repo, priority: readRepoPriority(repo), eligible: enrolled.has(repo) || catalog.get(repo)?.grantStage != null,
    queueDepth: depth ? depth.get(repo) ?? 0 : null, ...(facts.get(repo) ?? UNKNOWN),
  }));
  let freshness: unknown = null;
  if (freshnessSource.state === 'healthy') {
    try { freshness = JSON.parse(freshnessSource.text); } catch { /* Invalid evidence is not a finding. */ }
  }
  const allocation = allocateRepos(evidence, freshness, now);
  const byName = new Map(allocation.map(row => [row.repo, row]));
  return {
    schema: 'phantom.repos.v1' as const,
    asOf: new Date(now).toISOString(),
    enrollmentStatus: enrollment.state,
    prioritySync: 'local-only' as const,
    canManageGrant: canWriteStandingGrantHere(),
    repos: evidence.map(({ eligible: _eligible, ...row }) => {
      const observed = object(receipt[row.repo]);
      const recorded = observed.schema === 'work-market.v1' && observed.event === 'repo_share'
        && observed.repo === row.repo && observed.priority === row.priority
        && typeof observed.score === 'number' && Number.isFinite(observed.score) && observed.score >= 0
        && typeof observed.share === 'number' && observed.share >= 0 && observed.share <= 1
        && Array.isArray(observed.reason_codes) && observed.reason_codes.every(code => typeof code === 'string' && /^[a-z_]{1,64}$/.test(code))
        ? { repo: row.repo, score: observed.score, share: observed.share, reasonCodes: observed.reason_codes as string[] }
        : null;
      return {
        ...row, ...catalog.get(row.repo)!,
        enrolled: enrollment.state === 'degraded' ? null : enrolled.has(row.repo),
        allocation: {
          schema: 'work-market.v1' as const, event: 'repo_share' as const,
          source: recorded ? 'queue' as const : 'estimate' as const,
          ...(recorded ?? byName.get(row.repo)!),
        },
      };
    }),
  };
}

export type RepoGrantIntent = 'add' | 'remove' | 'propose' | 'merge';

export function planRepoChange(repo: string, intent: RepoGrantIntent) {
  const name = canonicalMarketRepo(repo);
  if (!name) throw new Error('Use a GitHub owner/name or a known ecosystem repository.');
  const { enrolled, grant } = scope();
  const signed = grant?.repos.some(row => row.nameWithOwner.toLowerCase() === name) ?? false;
  return {
    schema: 'phantom.repos.change.v1' as const,
    status: 'grant-required' as const,
    repo: name,
    intent,
    enrolled: enrolled.has(name),
    signed,
    message: intent === 'add' && !enrolled.has(name)
      ? 'First prepare and enroll this repository’s local checkout; that does not give it standing authority. Then review a new signed grant.'
      : intent === 'remove'
        ? 'Exclude this repository in the standing grant editor. For an immediate local stop, unenroll its checkout.'
        : 'Review the repository scope and rollout stages in the standing grant. Only Touch ID can approve the signed change.',
    command: ['phm', 'authority', 'draft', ...(intent === 'add' || intent === 'merge' ? ['--new'] : []), '--json'],
    setupCommands: intent === 'add' && !enrolled.has(name)
      ? [['phm', 'mirror', 'add', name], ['phm', 'enroll', 'add', '<checkout-path>']]
      : [],
  };
}
