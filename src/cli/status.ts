/**
 * status.ts — data gathering for `ashlr status` / `phm status`, and the
 * `--json` renderer.
 *
 * The human attention board in index.ts and `status --json` share the repo
 * classification here, so both report the same dirty / off-sync / stale /
 * clean buckets. The JSON path prints exactly one object on stdout with no
 * ANSI codes and no prose. Every best-effort section (tools, MCP, activity,
 * memory, GitHub, Vercel, identity, resources) is `null` when unavailable,
 * mirroring the human output, which silently omits it.
 */

import { existsSync } from 'node:fs';
import type {
  ActivityRollup,
  AshlrConfig,
  AshlrIndex,
  GenomeHealth,
  GithubStatus,
  Identity,
  IndexedItem,
  McpRegistry,
  ToolsRegistry,
  VercelStatus,
} from '../core/types.js';

/** Days since an ISO date string. */
function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

export interface RepoBuckets {
  /** Every indexed git repo. */
  repos: IndexedItem[];
  dirty: IndexedItem[];
  offSync: IndexedItem[];
  stale: IndexedItem[];
  clean: IndexedItem[];
}

/**
 * Classify indexed repos into the status buckets. A repo lands in the first
 * bucket that applies: dirty, then off-sync (ahead/behind), then stale
 * (last modified more than `staleDays` ago); everything else is clean.
 */
export function classifyRepos(idx: AshlrIndex, staleDays: number): RepoBuckets {
  const repos = idx.items.filter(i => i.kind === 'repo' && i.git);
  const dirty = repos.filter(i => (i.git?.dirty ?? 0) > 0);
  const offSync = repos.filter(i => !dirty.includes(i) && ((i.git?.ahead ?? 0) > 0 || (i.git?.behind ?? 0) > 0));
  const stale = repos.filter(i =>
    !dirty.includes(i) &&
    !offSync.includes(i) &&
    daysSince(i.lastModified) > staleDays
  );
  const clean = repos.filter(i => !dirty.includes(i) && !offSync.includes(i) && !stale.includes(i));
  return { repos, dirty, offSync, stale, clean };
}

/** Optional module loaders owned by index.ts (lazy, may be null). */
export interface StatusLoaders {
  getToolsRegistry: () => Promise<(() => ToolsRegistry) | null>;
  discoverMcpServers: () => Promise<(() => McpRegistry) | null>;
  buildRollup: () => Promise<((window: '7d', cfg: AshlrConfig) => ActivityRollup) | null>;
  githubStatus: () => Promise<((cwd: string) => GithubStatus) | null>;
  vercelStatus: () => Promise<((cwd: string) => VercelStatus) | null>;
  getIdentity: () => Promise<(() => Identity) | null>;
}

export interface StatusRepoRow {
  name: string;
  path: string;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  lastModified: string;
}

export interface StatusJson {
  schemaVersion: 1;
  summary: {
    tracked: number;
    clean: number;
    dirty: number;
    offSync: number;
    stale: number;
    staleDays: number;
  };
  /** Configured scan roots and whether each exists (the zero-repo diagnosis). */
  roots: Array<{ path: string; exists: boolean }>;
  dirty: StatusRepoRow[];
  offSync: StatusRepoRow[];
  stale: StatusRepoRow[];
  tools: { installed: number; total: number; installedIds: string[] } | null;
  mcpServers: { discovered: number } | null;
  activity7d: {
    sessions: number;
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    commits: number;
    budgetLevel: string;
  } | null;
  memory: { genomeEntries: number; projects: number; embeddingsAvailable: boolean } | null;
  github: { repo: string | null; openPrs: number; openIssues: number; ci: GithubStatus['ci'] } | null;
  vercel: { latestState: string | null; url: string | null } | null;
  identity: { user: string; tier: string | null; team: string | null } | null;
  resources: Array<{ backend: string; availability: string; usedPct: number | null }> | null;
}

function toRow(item: IndexedItem): StatusRepoRow {
  const g = item.git;
  return {
    name: item.name,
    path: item.path,
    branch: g?.branch ?? '',
    dirty: g?.dirty ?? 0,
    ahead: g?.ahead ?? 0,
    behind: g?.behind ?? 0,
    lastCommit: g?.lastCommit ?? null,
    lastModified: item.lastModified,
  };
}

/** Run a best-effort section; any failure yields null (never breaks status). */
async function attempt<T>(fn: () => Promise<T | null> | T | null): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Gather every fact the human status board shows, as plain data. */
export async function gatherStatus(
  cfg: AshlrConfig,
  idx: AshlrIndex,
  loaders: StatusLoaders,
  cwd: string = process.cwd(),
): Promise<StatusJson> {
  const b = classifyRepos(idx, cfg.staleDays);

  const tools = await attempt(async () => {
    const fn = await loaders.getToolsRegistry();
    if (!fn) return null;
    const reg = fn();
    return {
      installed: reg.installedCount,
      total: reg.tools.length,
      installedIds: reg.tools.filter(t => t.installed).map(t => t.id),
    };
  });

  const mcpServers = await attempt(async () => {
    const fn = await loaders.discoverMcpServers();
    return fn ? { discovered: fn().servers.length } : null;
  });

  const activity7d = await attempt(async () => {
    const fn = await loaders.buildRollup();
    if (!fn) return null;
    const rollup = fn('7d', cfg);
    const t = rollup.totals;
    return {
      sessions: t.sessions,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      estCostUsd: t.estCostUsd,
      commits: t.commits,
      budgetLevel: rollup.budget.level,
    };
  });

  const memory = await attempt(async () => {
    const genomeMod = await import('../core/genome/store.js' as unknown as string) as {
      genomeHealth: (cfg: AshlrConfig) => GenomeHealth;
    };
    const h = genomeMod.genomeHealth(cfg);
    return { genomeEntries: h.totalEntries, projects: h.projects, embeddingsAvailable: h.embeddingsAvailable };
  });

  const github = await attempt(async () => {
    const fn = await loaders.githubStatus();
    if (!fn) return null;
    const gs = fn(cwd);
    return gs.isRepo ? { repo: gs.repo, openPrs: gs.openPrs, openIssues: gs.openIssues, ci: gs.ci } : null;
  });

  const vercel = await attempt(async () => {
    const fn = await loaders.vercelStatus();
    if (!fn) return null;
    const vs = fn(cwd);
    return vs.linked ? { latestState: vs.latestState, url: vs.url } : null;
  });

  const identity = await attempt(async () => {
    const fn = await loaders.getIdentity();
    if (!fn) return null;
    const id = fn();
    return id.loggedIn && id.user ? { user: id.user, tier: id.tier, team: id.team } : null;
  });

  const resources = await attempt(async () => {
    const { getResourceSnapshot } = await import('../core/fabric/resource-monitor.js');
    const snap = await getResourceSnapshot(cfg);
    return snap.backends
      .filter(r => r.backend !== 'builtin')
      .map(r => ({ backend: r.backend, availability: r.availability, usedPct: r.usedPct }));
  });

  return {
    schemaVersion: 1,
    summary: {
      tracked: b.repos.length,
      clean: b.clean.length,
      dirty: b.dirty.length,
      offSync: b.offSync.length,
      stale: b.stale.length,
      staleDays: cfg.staleDays,
    },
    roots: cfg.roots.map(path => ({ path, exists: existsSync(path) })),
    dirty: b.dirty.map(toRow),
    offSync: b.offSync.map(toRow),
    stale: b.stale.map(toRow),
    tools,
    mcpServers,
    activity7d,
    memory,
    github,
    vercel,
    identity,
    resources,
  };
}

/** `status --json`: one JSON object on stdout, nothing else. */
export async function printStatusJson(cfg: AshlrConfig, idx: AshlrIndex, loaders: StatusLoaders): Promise<void> {
  const data = await gatherStatus(cfg, idx, loaders);
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
