/**
 * outside-pr-outcomes.ts — outcome metrics for merged PRs that are NOT fleet work.
 *
 * Community-scale RSI: outside contributors and their agents open PRs on
 * fleet repos, but the fleet's own ledgers (jobs.jsonl, merge-events.jsonl,
 * work-market.jsonl) only see `codex-bridge/*` work — a merged outside PR
 * leaves no outcome evidence at all. This module lists recently-merged PRs
 * per fleet repo through the same `gh` seam outside-prs.ts uses, keeps the
 * rows outside-prs.ts's rules call outside work (head not `codex-bridge/*`,
 * author not the fleet App), and joins each `owner/name#N` against the
 * standing revert set (improve/revert-ledger.ts) so a merged-then-reverted
 * community change is visible evidence instead of silence.
 *
 * Honesty rules: gh exposes only the PR author login and head branch —
 * it never records which agent or model produced the change. `agent` is
 * therefore convention attribution only: the head branch's first path
 * segment against the agent products' own branch namespaces
 * (`devin/…`, `cursor/…-hash`, `claude/…`, `copilot/…`), then a known
 * agent-bot author login (`devin-ai-integration[bot]`, …). A match is
 * recorded evidence the change came through that tool's convention —
 * never a claim about which model or runtime produced the diff — and
 * anything unmatched stays null, an honest unknown rather than a guess.
 * `model` is always null: no gh field records it. An absent `gh` reports
 * sourceState 'missing'; an unreadable revert ledger marks every revert
 * verdict 'unknown' rather than implying "not reverted"; a missing ledger
 * is a genuine empty evidence set. Never throws; malformed gh rows are
 * dropped, not defaulted.
 */
import { credentialExecFile as execFile } from '../integrations/secrets.js';
import { scrubSecrets } from '../util/scrub.js';
import { prKey } from '../improve/lesson-trial.js';
import { readRevertOutcomeRecords, standingRevertKeys } from '../improve/revert-ledger.js';
import {
  discoverFleetRepos,
  FLEET_BOT_LOGINS,
  FLEET_BRANCH_PREFIX,
  type FleetRepoDiscoveryOptions,
  type OutsidePrsGhRunner,
} from './outside-prs.js';

const GH_BIN = 'gh';
const GH_TIMEOUT_MS = 15_000;
const MAX_JSON_CHARS = 512 * 1024;
const MAX_TEXT_CHARS = 256;
const MAX_MERGED_PER_REPO = 200;
const MAX_REPOS = 10;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const MERGED_PR_FIELDS = 'number,title,author,mergedAt,headRefName';

/**
 * Agent products whose default pushed-branch namespace is `<product>/…`
 * (lowercase first path segment → product name). Deliberately a curated
 * table of agentic coding tools, not a prefix match on any word: `fix/`,
 * `docs/`, `feat/` and friends are human conventions and stay
 * unattributed. `ashlr-devin/` is the fleet's own Devin delivery branch
 * (src/core/devin/types.ts DEVIN_BRANCH_PREFIX) — same agent product, so
 * it attributes to 'devin' like the public `devin/` namespace.
 */
const AGENT_BRANCH_PREFIXES: Readonly<Record<string, string>> = {
  'devin': 'devin',
  'ashlr-devin': 'devin',
  'cursor': 'cursor',
  'claude': 'claude',
  'codex': 'codex',
  'copilot': 'copilot',
  'gemini': 'gemini',
  'jules': 'jules',
  'droid': 'droid',
  'windsurf': 'windsurf',
  'augment': 'augment',
  'aider': 'aider',
  'opencode': 'opencode',
  'amp': 'amp',
  'goose': 'goose',
  'crush': 'crush',
  'kimi': 'kimi',
  'grok': 'grok',
  'qwen': 'qwen',
  'junie': 'junie',
  'kiro': 'kiro',
  'cline': 'cline',
  'trae': 'trae',
  'dependabot': 'dependabot',
  'renovate': 'renovate',
};

/**
 * Agent-bot author logins (lowercased `login` or `app/<slug>` spelling)
 * whose account IS the agent product — the strongest recorded signal,
 * since the app identity is what opened the PR. Human logins never
 * appear here: `masonwyatt23`-style accounts push agent work under their
 * own name, so a login alone cannot attribute them (the branch can).
 */
const AGENT_AUTHOR_LOGINS: Readonly<Record<string, string>> = {
  'devin-ai-integration[bot]': 'devin',
  'app/devin-ai-integration': 'devin',
  'chatgpt-codex-connector[bot]': 'codex',
  'app/chatgpt-codex-connector': 'codex',
  'claude[bot]': 'claude',
  'copilot-swe-agent[bot]': 'copilot',
  'app/copilot-swe-agent': 'copilot',
  'app/dependabot': 'dependabot',
  'dependabot[bot]': 'dependabot',
  'app/renovate': 'renovate',
  'renovate[bot]': 'renovate',
};

/**
 * The agent product an outside PR is attributed to, or null.
 *
 * Convention attribution only, in evidence order: the head branch's first
 * path segment against AGENT_BRANCH_PREFIXES (the tool's own namespace is
 * the stronger recorded signal — fleet data shows agent sessions push
 * `devin/<ts>-<slug>` and `cursor/<slug>-<hash>` under the operator's own
 * login), then a known agent-bot author login. Anything else — human
 * logins, unmatched branches, ghost authors — stays null: gh records no
 * agent field, so an unrecognized convention is an honest unknown, never
 * a guess. Pure; never throws.
 */
export function outsidePrAgentAttribution(head: string, author: string | null): string | null {
  try {
    const slash = head.indexOf('/');
    if (slash > 0) {
      const byBranch = AGENT_BRANCH_PREFIXES[head.slice(0, slash).trim().toLowerCase()];
      if (byBranch !== undefined) return byBranch;
    }
    if (author !== null) {
      const login = author.trim().toLowerCase();
      if (login !== '') {
        const byAuthor = AGENT_AUTHOR_LOGINS[login];
        if (byAuthor !== undefined) return byAuthor;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type OutsidePrRevertVerdict = 'yes' | 'no' | 'unknown';

export interface OutsidePrOutcomeV1 {
  repo: string; number: number; title: string;
  /** gh author login, or null when gh recorded none (ghost author). */
  author: string | null; head: string; mergedAt: string;
  /** Agent product attributed by recorded branch/login convention; null = no known convention matched. */
  agent: string | null;
  /** gh never records which model produced a change — always null. */
  model: null;
  reverted: OutsidePrRevertVerdict;
}

export interface OutsidePrOutcomeRepoV1 {
  repo: string; state: 'healthy' | 'degraded';
  /** Merged PR rows gh returned before window/author filtering — coverage honesty. */
  listed: number;
  /** True when gh's --limit may have cut the merged list short. */
  hitLimit: boolean;
  prs: OutsidePrOutcomeV1[];
}

export interface OutsidePrAuthorOutcomeV1 {
  /** gh login, or null when gh recorded no author. */
  author: string | null;
  /**
   * Always null on the per-login rollup: one login pushes work for many
   * agents (fleet data: the operator's own account authors `devin/`,
   * `cursor/` and human branches alike), so a login alone cannot
   * attribute — the per-PR `agent` field and the `agents` rollup carry
   * the convention attribution instead.
   */
  agent: null; model: null;
  prs: number; reverted: number;
}

export interface OutsidePrAgentOutcomeV1 {
  /**
   * Agent product the recorded branch/login convention attributes the
   * PRs to; null is the unattributed bucket — no known convention
   * matched, an honest unknown rather than a guess.
   */
  agent: string | null;
  /** gh never records which model produced a change — always null. */
  model: null;
  prs: number; reverted: number;
}

export interface OutsidePrOutcomesV1 {
  v: 1; generatedAt: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  windowDays: number; since: string;
  /** Standing revert ledger state; 'unreadable' forces every verdict to 'unknown'. */
  revertLedger: 'read' | 'missing' | 'unreadable';
  repos: OutsidePrOutcomeRepoV1[];
  authors: OutsidePrAuthorOutcomeV1[];
  /** Per attributed-agent rollup — the community-seat outcome evidence. */
  agents: OutsidePrAgentOutcomeV1[];
}

export interface ListOutsidePrOutcomesOptions extends FleetRepoDiscoveryOptions {
  gh?: OutsidePrsGhRunner;
  /** Outcome window in days (default 30, clamped to 1..365). */
  days?: number;
  /** gh --limit per repo (default 100, capped at MAX_MERGED_PER_REPO). */
  limit?: number;
  /** Revert-outcomes ledger path. Default: the improve/revert-outcomes.jsonl under ashlr home. */
  revertLedgerPath?: string;
  now?: () => Date;
}

/** Same spawn shape as outside-prs.ts's realGh: no shell, array args, tight timeout. */
const realGh: OutsidePrsGhRunner = (cwd, args) =>
  new Promise((resolveOut) => {
    try {
      execFile(GH_BIN, [...args], {
        cwd, timeout: GH_TIMEOUT_MS, encoding: 'utf8', maxBuffer: MAX_JSON_CHARS * 2, windowsHide: true,
        env: { ...process.env, GH_HOST: 'github.com', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      }, (err, stdout) => resolveOut(err || typeof stdout !== 'string' ? null : stdout.trim()));
    } catch {
      resolveOut(null);
    }
  });

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function safeJson(raw: string | null): unknown {
  if (!raw || raw.length > MAX_JSON_CHARS) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

function text(value: unknown, max = MAX_TEXT_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const clean = scrubSecrets(value.trim());
  return clean.length === 0 || clean.length > max ? null : clean;
}

function authorLogin(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : isRecord(value) && typeof value['login'] === 'string' ? value['login'] : null;
  if (raw === null) return null;
  const clean = scrubSecrets(raw.trim());
  return clean.length === 0 || clean.length > 128 ? null : clean;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

interface RawMergedPr { number: number; title: string; author: string | null; head: string; mergedAt: string }

/** Parse `gh pr list --state merged --json <MERGED_PR_FIELDS>`; malformed entries are dropped. */
function parseMergedList(parsed: unknown): RawMergedPr[] {
  if (!Array.isArray(parsed)) return [];
  const out: RawMergedPr[] = [];
  for (const raw of parsed) {
    if (!isRecord(raw)) continue;
    const n = typeof raw['number'] === 'number' && Number.isSafeInteger(raw['number']) && raw['number'] > 0 ? raw['number'] : null;
    const title = text(raw['title']);
    const head = text(raw['headRefName']);
    const mergedAt = isoTime(raw['mergedAt']);
    if (n === null || title === null || head === null || mergedAt === null) continue;
    out.push({ number: n, title, author: authorLogin(raw['author']), head, mergedAt });
  }
  return out;
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * Merged outside PRs on the repos fleet work touches (the same repo set
 * outside-prs.ts scans), each joined to the standing revert set. Never
 * throws and emits no path, URL, token or hostname — repos leave as
 * `owner/name` only.
 */
async function computeOutsidePrOutcomes(opts: ListOutsidePrOutcomesOptions): Promise<OutsidePrOutcomesV1> {
  const gh = opts.gh ?? realGh;
  const now = opts.now ?? (() => new Date());
  const generatedAt = now();
  const days = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(opts.days ?? DEFAULT_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS));
  const sinceMs = generatedAt.getTime() - days * 86_400_000;
  const limit = Math.min(MAX_MERGED_PER_REPO, Math.max(1, Math.floor(opts.limit ?? 100) || 100));
  const workspaceDir = opts.workspaceDir ?? process.cwd();
  const result: OutsidePrOutcomesV1 = {
    v: 1, generatedAt: generatedAt.toISOString(), sourceState: 'healthy',
    windowDays: days, since: new Date(sinceMs).toISOString(),
    revertLedger: 'missing', repos: [], authors: [], agents: [],
  };
  const degrade = () => { if (result.sourceState === 'healthy') result.sourceState = 'degraded'; };

  const ledgerRead = readRevertOutcomeRecords(opts.revertLedgerPath);
  result.revertLedger = ledgerRead.state;
  const revertKnown = ledgerRead.state !== 'unreadable';
  const revertedKeys = revertKnown && ledgerRead.state === 'read' ? standingRevertKeys(ledgerRead.records) : new Set<string>();

  // `gh --version` needs no auth and no network: a null answer means the
  // binary itself is absent, and the whole read is honestly 'missing'.
  if ((await gh(workspaceDir, ['--version'])) === null) {
    result.sourceState = 'missing';
    return result;
  }

  const discovery = await discoverFleetRepos({
    runsDir: opts.runsDir, homeDir: opts.homeDir, workspaceDir,
    runningJobs: opts.runningJobs, jobWorktree: opts.jobWorktree, repoIdentity: opts.repoIdentity,
  });
  if (discovery.degraded) degrade();

  const authorCounts = new Map<string | null, { prs: number; reverted: number }>();
  const agentCounts = new Map<string | null, { prs: number; reverted: number }>();
  result.repos = await mapConcurrent([...discovery.repoCwds.entries()].slice(0, MAX_REPOS), 4, async ([repo, cwd]) => {
    const listed = safeJson(await gh(cwd, ['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', MERGED_PR_FIELDS]));
    if (!Array.isArray(listed)) return { repo, state: 'degraded' as const, listed: 0, hitLimit: false, prs: [] };
    const rows = parseMergedList(listed);
    const outside = rows.filter(
      (pr) => !pr.head.startsWith(FLEET_BRANCH_PREFIX) && !FLEET_BOT_LOGINS.has((pr.author ?? '').toLowerCase()));
    const prs: OutsidePrOutcomeV1[] = outside
      .filter((pr) => Date.parse(pr.mergedAt) >= sinceMs)
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.number - a.number)
      .map((pr) => {
        const reverted: OutsidePrRevertVerdict = !revertKnown ? 'unknown' : revertedKeys.has(prKey(repo, pr.number)) ? 'yes' : 'no';
        const agent = outsidePrAgentAttribution(pr.head, pr.author);
        const cell = authorCounts.get(pr.author) ?? { prs: 0, reverted: 0 };
        cell.prs += 1;
        if (reverted === 'yes') cell.reverted += 1;
        authorCounts.set(pr.author, cell);
        const agentCell = agentCounts.get(agent) ?? { prs: 0, reverted: 0 };
        agentCell.prs += 1;
        if (reverted === 'yes') agentCell.reverted += 1;
        agentCounts.set(agent, agentCell);
        return { repo, number: pr.number, title: pr.title, author: pr.author, head: pr.head, mergedAt: pr.mergedAt, agent, model: null, reverted };
      });
    return { repo, state: 'healthy' as const, listed: rows.length, hitLimit: rows.length >= limit, prs };
  });
  if (result.repos.some((repo) => repo.state === 'degraded')) degrade();

  result.authors = [...authorCounts.entries()]
    .map(([author, c]) => ({ author, agent: null, model: null, prs: c.prs, reverted: c.reverted }))
    .sort((a, b) => b.prs - a.prs || (a.author ?? '').localeCompare(b.author ?? ''));
  result.agents = [...agentCounts.entries()]
    .map(([agent, c]) => ({ agent, model: null, prs: c.prs, reverted: c.reverted }))
    .sort((a, b) => b.prs - a.prs || (a.agent ?? '').localeCompare(b.agent ?? ''));
  return result;
}

/** Read-only entry point; every call computes live so injected seams never see a stale cache. */
export function listOutsidePrOutcomes(opts: ListOutsidePrOutcomesOptions = {}): Promise<OutsidePrOutcomesV1> {
  return computeOutsidePrOutcomes(opts);
}
