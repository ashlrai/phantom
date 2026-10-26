/**
 * status.ts — data gathering for `ashlr status` / `phm status`, and the
 * `--json` renderer.
 *
 * The human attention board and `status --json` share the repo
 * classification here, so both report the same dirty / off-sync / stale /
 * clean buckets. The JSON path prints exactly one object on stdout with no
 * ANSI codes and no prose. Every best-effort section (tools, MCP, activity,
 * memory, GitHub, Vercel, identity, resources, custody) is `null` when unavailable,
 * mirroring the human output, which silently omits it.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig, CONFIG_PATH } from '../core/config.js';
import { buildIndex, loadIndex, writeIndex } from '../core/index-engine.js';
import { pad, makeColors } from './ui.js';
import { failCliCommand } from './cli-error.js';
import type {
  ActivityRollup,
  AshlrConfig,
  AshlrIndex,
  GenomeHealth,
  GitStatus,
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

/** Optional status modules (lazy, may be null). */
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
  /** Receipt.v1 and custody ledger counts; null when nothing was ever recorded. */
  custody: import('./status-custody.js').CustodyStatus | null;
  /** Local inference probe (loopback GET /models); null when not configured or it could not run. */
  localInference: import('../core/run/local-inference-probe.js').LocalInferenceProbe | null;
  /** Strict phantom preflight; null unless ASHLR_PHANTOM_PREFLIGHT=1 and phantom is configured. */
  phantomPreflight: import('./status-preflight.js').PreflightStatus | null;
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

  const custody = await attempt(async () => {
    const { gatherCustodyStatus } = await import('./status-custody.js');
    return gatherCustodyStatus();
  });

  const localInference = await attempt(async () => {
    const { probeLocalInference } = await import('../core/run/local-inference-probe.js');
    const p = await probeLocalInference((cfg as unknown as Record<string, unknown>)['localInference']);
    return p.status === 'not-configured' ? null : p;
  });

  const phantomPreflight = await attempt(async () => {
    const { gatherPreflightStatus } = await import('./status-preflight.js');
    return gatherPreflightStatus({ cwd });
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
    custody,
    localInference,
    phantomPreflight,
  };
}

/** `status --json`: one JSON object on stdout, nothing else. */
export async function printStatusJson(cfg: AshlrConfig, idx: AshlrIndex, loaders: StatusLoaders): Promise<void> {
  const data = await gatherStatus(cfg, idx, loaders);
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

type GetToolsRegistryFn = () => ToolsRegistry;
type DiscoverMcpServersFn = () => McpRegistry;

// Cache slots — undefined = not yet attempted; null = attempted & failed
let _getToolsRegistry: GetToolsRegistryFn | null | undefined = undefined;
let _discoverMcpServers: DiscoverMcpServersFn | null | undefined = undefined;

async function tryGetToolsRegistry(): Promise<GetToolsRegistryFn | null> {
  if (_getToolsRegistry === undefined) {
    try {
      const mod = await import('../core/tools-registry.js') as { getToolsRegistry: GetToolsRegistryFn };
      _getToolsRegistry = mod.getToolsRegistry;
    } catch {
      _getToolsRegistry = null;
    }
  }
  return _getToolsRegistry ?? null;
}

async function tryDiscoverMcpServers(): Promise<DiscoverMcpServersFn | null> {
  if (_discoverMcpServers === undefined) {
    try {
      const mod = await import('../core/mcp-registry.js') as { discoverMcpServers: DiscoverMcpServersFn };
      _discoverMcpServers = mod.discoverMcpServers;
    } catch {
      _discoverMcpServers = null;
    }
  }
  return _discoverMcpServers ?? null;
}

type BuildRollupFn = (window: '1d' | '7d' | '30d', cfg: AshlrConfig, opts?: { project?: string }) => ActivityRollup;

let _buildRollup: BuildRollupFn | null | undefined = undefined;

async function tryBuildRollup(): Promise<BuildRollupFn | null> {
  if (_buildRollup === undefined) {
    try {
      const mod = (await import('../core/observability/rollup.js' as unknown as string)) as { buildRollup: BuildRollupFn };
      _buildRollup = mod.buildRollup;
    } catch {
      _buildRollup = null;
    }
  }
  return _buildRollup ?? null;
}

// Best-effort integration reads; failures never break status.

type GithubStatusFn = (cwd: string) => GithubStatus;
type VercelStatusFn = (cwd: string) => VercelStatus;
type GetIdentityFn  = () => Identity;

let _githubStatus: GithubStatusFn | null | undefined = undefined;
let _vercelStatus: VercelStatusFn | null | undefined = undefined;
let _getIdentity:  GetIdentityFn  | null | undefined = undefined;

async function tryGithubStatus(): Promise<GithubStatusFn | null> {
  if (_githubStatus === undefined) {
    try {
      const mod = (await import('../core/integrations/github.js' as unknown as string)) as { githubStatus: GithubStatusFn };
      _githubStatus = mod.githubStatus;
    } catch {
      _githubStatus = null;
    }
  }
  return _githubStatus ?? null;
}

async function tryVercelStatus(): Promise<VercelStatusFn | null> {
  if (_vercelStatus === undefined) {
    try {
      const mod = (await import('../core/integrations/vercel.js' as unknown as string)) as { vercelStatus: VercelStatusFn };
      _vercelStatus = mod.vercelStatus;
    } catch {
      _vercelStatus = null;
    }
  }
  return _vercelStatus ?? null;
}

async function tryGetIdentity(): Promise<GetIdentityFn | null> {
  if (_getIdentity === undefined) {
    try {
      const mod = (await import('../core/integrations/identity.js' as unknown as string)) as { getIdentity: GetIdentityFn };
      _getIdentity = mod.getIdentity;
    } catch {
      _getIdentity = null;
    }
  }
  return _getIdentity ?? null;
}

// Keep the original attention-board palette; NO_COLOR still wins.
const { bold, dim, red, green, yellow, cyan, gray } = makeColors(true);

/** Ensure the index exists; auto-build if missing. Returns the index. */
export function requireIndex(cfg: AshlrConfig): AshlrIndex {
  let idx = loadIndex();
  if (!idx) {
    // Informational chatter goes to stderr so stdout stays clean for capture
    // (e.g. `cd $(ashlr go foo --cd)`).
    console.error(dim('No index found — building now…'));
    idx = buildIndex(cfg);
    writeIndex(idx);
  }
  return idx;
}

/** Format a short relative time. */
export function relativeTime(iso: string | null): string {
  if (!iso) return gray('—');
  const days = daysSince(iso);
  if (days < 1) return green('today');
  if (days < 2) return green('yesterday');
  if (days < 7) return green(`${Math.floor(days)}d ago`);
  if (days < 30) return yellow(`${Math.floor(days)}d ago`);
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return red(`${Math.floor(days / 365)}y ago`);
}

// ─── Command: status ─────────────────────────────────────────────────────────

/**
 * Printed when the index contains zero git repos. The overwhelmingly common
 * cause is that `roots` doesn't point at where the user's code lives — e.g. a
 * default config carried over from another machine (the defaults assume
 * ~/Desktop/github). Rather than a bare "0 repos tracked", show which roots
 * were scanned, whether each one exists, and the exact commands to fix it.
 */
export function printNoReposHelp(cfg: AshlrConfig): void {
  console.log(yellow('  No git repos are being tracked yet.'));
  console.log('');
  console.log(`  phm scanned these ${bold('roots')} ${dim('— folders expected to CONTAIN your repos:')}`);
  console.log('');
  if (cfg.roots.length === 0) {
    console.log(`    ${red('✗')} ${dim('(no roots configured)')}`);
  } else {
    for (const root of cfg.roots) {
      const exists = existsSync(root);
      const mark = exists ? yellow('•') : red('✗');
      const tag  = exists ? gray('exists, no repos found inside') : red('missing');
      console.log(`    ${mark} ${root}  ${dim('—')} ${tag}`);
    }
  }
  console.log('');
  console.log(`  ${bold('Fix it')} ${dim('— point phm at the folder that holds your repos')}`);
  console.log(`  ${dim('(repos must be direct children, e.g.')} ${cyan('<root>/my-app/.git')}${dim('):')}`);
  console.log('');
  console.log(`    ${cyan('1.')} Set your roots:`);
  // Only this platform's quoting: a Linux user should not have to skip past PowerShell.
  if (process.platform === 'win32') {
    console.log(`       ${dim('Windows PowerShell — note the doubled')} ${bold('""')} ${dim('quotes:')}`);
    console.log(`       ${cyan('phm config set roots --json \'[""C:/Users/you/code""]\'')}`);
  } else {
    console.log(`       ${cyan(`phm config set roots --json '${JSON.stringify([`${homedir()}/code`])}'`)}`);
  }
  console.log(`       ${dim('…or edit')} ${cyan(CONFIG_PATH)} ${dim('directly.')}`);
  console.log('');
  console.log(`    ${cyan('2.')} Rebuild the index:  ${cyan('phm index --refresh')}`);
  console.log('');
  console.log(`  ${dim('Then re-run')} ${cyan('phm status')}${dim('.')}`);
  console.log('');
}

async function cmdStatus(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const idx = requireIndex(cfg);

  if (args.includes('--json')) {
    await printStatusJson(cfg, idx, {
      getToolsRegistry: tryGetToolsRegistry,
      discoverMcpServers: tryDiscoverMcpServers,
      buildRollup: tryBuildRollup,
      githubStatus: tryGithubStatus,
      vercelStatus: tryVercelStatus,
      getIdentity: tryGetIdentity,
    });
    return;
  }

  const { repos, dirty, offSync, stale } = classifyRepos(idx, cfg.staleDays);

  // Zero repos → the index is empty or roots are misconfigured. Show actionable
  // setup guidance instead of an empty attention board, then stop.
  if (repos.length === 0) {
    console.log('');
    console.log(bold('  ashlr status') + gray(' — 0 repos tracked'));
    console.log('');
    printNoReposHelp(cfg);
    return;
  }

  const nameW  = 30;
  const branchW = 18;
  const gitW   = 16;
  const timeW  = 14;

  function printRepoTable(items: IndexedItem[]): void {
    if (items.length === 0) {
      console.log(`  ${dim('(none)')}`);
      return;
    }
    console.log(
      `  ${bold(pad('Repo', nameW))}  ` +
      `${bold(pad('Branch', branchW))}  ` +
      `${bold(pad('Git', gitW))}  ` +
      `${bold(pad('Last commit', timeW))}`
    );
    console.log(
      `  ${'─'.repeat(nameW)}  ${'─'.repeat(branchW)}  ${'─'.repeat(gitW)}  ${'─'.repeat(timeW)}`
    );
    for (const item of items) {
      const g = item.git as GitStatus;
      const dirtyStr = g.dirty > 0
        ? red(`${g.dirty}`)
        : '';
      const syncStr  = g.ahead > 0 || g.behind > 0
        ? yellow(`↑${g.ahead} ↓${g.behind}`)
        : '';
      const gitCol = [dirtyStr, syncStr].filter(Boolean).join('  ') || green('ok');
      console.log(
        `  ${pad(cyan(item.name), nameW)}  ` +
        `${pad(g.branch, branchW)}  ` +
        `${pad(gitCol, gitW)}  ` +
        `${relativeTime(g.lastCommit)}`
      );
    }
  }

  console.log('');
  console.log(bold('  ashlr status') + gray(` — ${repos.length} repos tracked`));
  console.log('');

  if (dirty.length > 0) {
    console.log(bold(red(`  Dirty (${dirty.length})`)));
    printRepoTable(dirty);
    console.log('');
  }

  if (offSync.length > 0) {
    console.log(bold(yellow(`  Off-sync (${offSync.length})`)));
    printRepoTable(offSync);
    console.log('');
  }

  if (stale.length > 0) {
    console.log(bold(gray(`  Stale — >  ${cfg.staleDays}d (${stale.length})`)));
    printRepoTable(stale);
    console.log('');
  }

  const cleanActive = repos.filter(i =>
    !dirty.includes(i) && !offSync.includes(i) && !stale.includes(i)
  );

  console.log(
    `  ${green(`${cleanActive.length} clean`)}  ` +
    `${red(`${dirty.length} dirty`)}  ` +
    `${yellow(`${offSync.length} off-sync`)}  ` +
    `${gray(`${stale.length} stale`)}`
  );
  console.log('');

  // ── M3 Ecosystem summary (graceful degradation if modules not yet built) ──
  const [getToolsRegistryFn, discoverMcpServersFn] = await Promise.all([
    tryGetToolsRegistry(),
    tryDiscoverMcpServers(),
  ]);

  const ecosystemParts: string[] = [];

  if (getToolsRegistryFn) {
    try {
      const reg = getToolsRegistryFn();
      const installedNames = reg.tools
        .filter(t => t.installed)
        .map(t => t.id)
        .slice(0, 5); // show up to 5 names; remainder implied by count
      const moreCount = reg.installedCount - installedNames.length;
      const nameList = installedNames.join(', ') + (moreCount > 0 ? `, +${moreCount}` : '');
      ecosystemParts.push(
        `${bold('Tools:')} ${cyan(`${reg.installedCount}/${reg.tools.length} installed`)}` +
        (installedNames.length > 0 ? ` ${dim('—')} ${gray(nameList)}` : '')
      );
    } catch {
      // silently skip on error
    }
  }

  if (discoverMcpServersFn) {
    try {
      const mcpReg = discoverMcpServersFn();
      ecosystemParts.push(
        `${bold('MCP servers:')} ${cyan(`${mcpReg.servers.length} discovered`)}`
      );
    } catch {
      // silently skip on error
    }
  }

  if (ecosystemParts.length > 0) {
    console.log(`  ${ecosystemParts.join(`  ${dim('·')}  `)}`);
    console.log('');
  }

  // ── M5 Activity summary (best-effort; silently skipped on error) ──────────
  try {
    const buildRollupFn = await tryBuildRollup();
    if (buildRollupFn) {
      const rollup = buildRollupFn('7d', cfg);
      const t = rollup.totals;
      const tokK = ((t.tokensIn + t.tokensOut) / 1000).toFixed(1);
      const cost = t.estCostUsd.toFixed(2);
      const BUDGET_SUFFIX: Record<string, string> = {
        over: `  ${red('● over budget')}`,
        warn: `  ${yellow('● near cap')}`,
      };
      const budgetSuffix = BUDGET_SUFFIX[rollup.budget.level] ?? '';
      console.log(
        `  ${bold('Activity (7d):')} ${cyan(`${t.sessions} sessions`)}  ${dim('·')}  ` +
        `${cyan(`${tokK}k tokens`)}  ${dim('·')}  ` +
        `${cyan(`$${cost}`)}  ${dim('·')}  ` +
        `${cyan(`${t.commits} commits`)}` +
        budgetSuffix
      );
      console.log('');
    }
  } catch {
    // silently omit — never break status
  }

  // ── M7 Genome summary (best-effort; silently omitted on error) ────────────
  try {
    const genomeMod = await import('../core/genome/store.js' as unknown as string) as {
      genomeHealth: (cfg: AshlrConfig) => import('../core/types.js').GenomeHealth;
    };
    const health = genomeMod.genomeHealth(cfg);
    console.log(
      `  ${bold('Memory:')} ${cyan(`${health.totalEntries} genome entries`)} across ` +
      `${cyan(`${health.projects} project${health.projects !== 1 ? 's' : ''}`)}` +
      (health.embeddingsAvailable ? `  ${dim('·')}  ${gray('embeddings available')}` : '')
    );
    console.log('');
  } catch {
    // silently omit — genome may not be built yet; never break status
  }

  // ── M18 GitHub / Vercel / Identity one-liners (best-effort; never break status) ──
  // All reads are bounded (reuse installed CLIs; they own auth) and silently
  // omitted when not applicable (not a gh repo, no vercel link, not logged in).
  const cwd = process.cwd();

  // GitHub: only surface when cwd is a gh repo
  try {
    const ghStatusFn = await tryGithubStatus();
    if (ghStatusFn) {
      const gs = ghStatusFn(cwd);
      if (gs.isRepo) {
        const ciStr = gs.ci === 'passing'
          ? green('CI passing')
          : gs.ci === 'failing'
            ? red('CI failing')
            : gs.ci === 'pending'
              ? yellow('CI pending')
              : dim('no CI');
        const repoLabel = gs.repo ? gray(` (${gs.repo})`) : '';
        console.log(
          `  ${bold('GitHub:')} ${cyan(`${gs.openPrs} open PR${gs.openPrs !== 1 ? 's' : ''}`)}` +
          `  ${dim('·')}  ${cyan(`${gs.openIssues} open issue${gs.openIssues !== 1 ? 's' : ''}`)}` +
          `  ${dim('·')}  ${ciStr}${repoLabel}`
        );
        console.log('');
      }
    }
  } catch {
    // silently omit — never break status
  }

  // Vercel: only surface when a project is linked
  try {
    const vcStatusFn = await tryVercelStatus();
    if (vcStatusFn) {
      const vs = vcStatusFn(cwd);
      if (vs.linked) {
        const stateStr = vs.latestState
          ? (vs.latestState === 'READY' ? green(vs.latestState) : yellow(vs.latestState))
          : dim('unknown');
        const urlStr = vs.url ? `  ${dim('·')}  ${cyan(vs.url)}` : '';
        console.log(`  ${bold('Vercel:')} ${stateStr}${urlStr}`);
        console.log('');
      }
    }
  } catch {
    // silently omit — never break status
  }

  // Identity: only surface when phantom is logged in
  try {
    const identityFn = await tryGetIdentity();
    if (identityFn) {
      const id = identityFn();
      if (id.loggedIn && id.user) {
        const tierStr = id.tier ? `  ${dim('·')}  tier ${cyan(id.tier)}` : '';
        const teamStr = id.team ? `  ${dim('·')}  team ${cyan(id.team)}` : '';
        console.log(`  ${bold('You:')} ${cyan(id.user)}${tierStr}${teamStr}`);
        console.log('');
      }
    }
  } catch {
    // silently omit — never break status
  }

  // Custody: receipt.v1 and spawn custody counts (value-free; quiet when unused)
  try {
    const { gatherCustodyStatus, formatCustodyStatusLine } = await import('./status-custody.js');
    const custody = gatherCustodyStatus();
    if (custody) {
      console.log(`  ${bold('Custody:')} ${formatCustodyStatusLine(custody)}`);
      console.log('');
    }
  } catch {
    // silently omit; never break status
  }

  // Phantom strict preflight: only when the spawn gate is on (value-free)
  try {
    const { gatherPreflightStatus, formatPreflightStatusLine } = await import('./status-preflight.js');
    const pre = gatherPreflightStatus();
    if (pre) {
      console.log(`  ${bold('Preflight:')} ${formatPreflightStatusLine(pre)}`);
      console.log('');
    }
  } catch {
    // silently omit; never break status
  }

  // ── M253 Resource Control Plane summary (best-effort; never break status) ──
  try {
    const resourcesMod = await import('./resources.js' as unknown as string) as {
      resourceStatusLine: (cfg: unknown) => Promise<string | null>;
    };
    const line = await resourcesMod.resourceStatusLine(cfg);
    if (line) {
      console.log(`  ${line}`);
      console.log('');
    }
  } catch {
    // silently omit — resource sensing never breaks the status command
  }
}

/** Installed and source entrypoints use the same status handler and errors. */
export async function runStatus(args: string[]): Promise<void> {
  try {
    await cmdStatus(args);
  } catch (err) {
    failCliCommand(err);
  }
}
