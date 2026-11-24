/**
 * Release cadence: how stale is each Ashlr repo's latest release. Backs `phm release cadence` and the
 * `release_stale` alert in `phm fleet pulse --alerts`. Mason's standing order is releases several times a day.
 *
 * Reads the public GitHub API through plain `fetch` (the same unauthenticated read `fleet/supply.ts` uses): no new
 * auth and no `gh` shell-out. `buildReleaseCadence` is pure. A value that could not be read is the string "unknown",
 * never a guess; an unreadable repo is never counted as fresh.
 */
export const CADENCE_SCHEMA = 'phantom.release-cadence/v1' as const;
export const CADENCE_REPOS = ['phantom', 'phantom-secrets', 'ashlr-plugin', 'ashlr-stack', 'locus', 'lexicon', 'ashlr-md'] as const;
export const CADENCE_OWNER = 'ashlrai';
/** Under this many hours since the release a repo is fresh whatever has merged; over DUE_HOURS with merges it is stale. */
export const FRESH_HOURS = 6;
export const DUE_HOURS = 24;
export const UNKNOWN = 'unknown' as const;
export type Unknown = typeof UNKNOWN;
export type CadenceStatus = 'fresh' | 'due' | 'stale' | 'no_release' | Unknown;

export interface CadenceInput {
  repo: string;
  /** Null: the repo has no published release. Absent (`readable: false`): the read failed. */
  release: { tag: string; publishedAt: string; assets: number } | null;
  /** PRs merged after the release was published; null when it could not be counted. */
  mergedSince: number | null;
  readable?: boolean;
}
export interface CadenceRow {
  repo: string;
  latest_tag: string | Unknown;
  published_at: string | Unknown;
  /** False for a published release with 0 assets (the v3.30.8 failure mode). */
  has_assets: boolean | Unknown;
  hours_since: number | Unknown;
  merged_since: number | Unknown;
  status: CadenceStatus;
}
export interface CadenceV1 { schema: typeof CADENCE_SCHEMA; as_of: string; repos: CadenceRow[] }

const count = (n: number | null): number | Unknown => n !== null && Number.isSafeInteger(n) && n >= 0 ? n : UNKNOWN;

/** Pure: one row per input at `now` (ms). */
export function buildReleaseCadence(inputs: readonly CadenceInput[], now: number): CadenceV1 {
  const repos = inputs.map((input): CadenceRow => {
    const merged = count(input.mergedSince);
    const unreadable = { repo: input.repo, latest_tag: UNKNOWN, published_at: UNKNOWN, has_assets: UNKNOWN, hours_since: UNKNOWN, merged_since: merged, status: UNKNOWN } as const;
    if (input.readable === false) return unreadable;
    if (input.release === null) return { ...unreadable, latest_tag: 'none', status: 'no_release' };
    const at = Date.parse(input.release.publishedAt);
    if (!Number.isFinite(at)) return { ...unreadable, latest_tag: input.release.tag, has_assets: input.release.assets > 0 };
    const hours = Math.round(Math.max(0, now - at) / 36_000) / 100;
    const status: CadenceStatus = hours < FRESH_HOURS || merged === 0 ? 'fresh' : merged === UNKNOWN ? UNKNOWN : hours <= DUE_HOURS ? 'due' : 'stale';
    return { repo: input.repo, latest_tag: input.release.tag, published_at: new Date(at).toISOString(), has_assets: input.release.assets > 0, hours_since: hours, merged_since: merged, status };
  });
  return { schema: CADENCE_SCHEMA, as_of: new Date(now).toISOString(), repos };
}

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
export interface ReadCadenceOpts { repos?: readonly string[]; now?: number; fetch?: Fetch }

const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

async function readOne(get: (path: string) => Promise<unknown>, repo: string): Promise<CadenceInput> {
  const slug = `${CADENCE_OWNER}/${repo}`;
  let list: unknown;
  try { list = await get(`repos/${slug}/releases?per_page=10`); } catch { return { repo, release: null, mergedSince: null, readable: false }; }
  if (!Array.isArray(list)) return { repo, release: null, mergedSince: null, readable: false };
  // The latest real release: not a draft, not a prerelease (the API lists newest first).
  const latest = list.map(rec).find(r => r && r.draft === false && r.prerelease === false);
  if (!latest) return { repo, release: null, mergedSince: 0 };
  const tag = latest.tag_name, published = latest.published_at, assets = latest.assets;
  if (typeof tag !== 'string' || typeof published !== 'string' || !Array.isArray(assets) || !Number.isFinite(Date.parse(published))) return { repo, release: null, mergedSince: null, readable: false };
  const q = encodeURIComponent(`repo:${slug} is:pr is:merged merged:>${new Date(published).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  let merged: number | null = null;
  try { const total = rec(await get(`search/issues?q=${q}&per_page=1`))?.total_count; merged = typeof total === 'number' ? total : null; } catch { /* stays unknown */ }
  return { repo, release: { tag, publishedAt: published, assets: assets.length }, mergedSince: merged };
}

/** Read every repo once, in parallel. Read-only; a failed read leaves that repo "unknown". Never throws. */
export async function readReleaseCadence(opts: ReadCadenceOpts = {}): Promise<CadenceV1> {
  const doFetch: Fetch = opts.fetch ?? (fetch as unknown as Fetch);
  const get = async (path: string): Promise<unknown> => {
    const res = await doFetch(`https://api.github.com/${path}`, { headers: { 'User-Agent': 'phantom-release-cadence', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error('github read failed');
    return res.json();
  };
  const now = opts.now ?? Date.now();
  return buildReleaseCadence(await Promise.all((opts.repos ?? CADENCE_REPOS).map(repo => readOne(get, repo))), now);
}

const ago = (h: number): string => h < 48 ? `${Math.round(h * 10) / 10} hours` : `${Math.floor(h / 24)} days`;

/** Plain words for a terminal: one line per repo. */
export function cadenceText(report: CadenceV1): string[] {
  return [`Release cadence (${report.as_of}):`, ...report.repos.map(r => {
    const state = r.status === 'no_release' ? 'no release yet'
      : r.status === UNKNOWN ? `unknown (${r.latest_tag === UNKNOWN ? 'could not read it' : `${r.latest_tag}, ${r.merged_since} merged`})`
      : `${r.status}: ${r.latest_tag} ${ago(r.hours_since as number)} ago, ${r.merged_since} merged since`;
    return `  ${r.repo}: ${state}${r.has_assets === false ? ' - release has NO assets' : ''}`;
  })];
}
