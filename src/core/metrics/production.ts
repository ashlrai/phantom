import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';

const exec = promisify(execFile);
export type Evidence = 'yes' | 'no' | 'unknown';
export interface ProductionReads {
  github(path: string, paginate?: boolean): Promise<unknown>;
  registry(url: string): Promise<unknown>;
}
export const productionReads: ProductionReads = {
  async github(path, paginate = false) {
    try {
      const { stdout } = await exec('gh', ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])],
        { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
      return JSON.parse(stdout) as unknown;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'stderr' in error
        && /\(HTTP 404\)/.test(String(error.stderr))) return null;
      throw new Error('GitHub read unavailable');
    }
  },
  async registry(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'phantom-production-metrics' }, redirect: 'error' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Registry read unavailable');
    return response.json();
  },
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evidence');
  return value as ObjectValue;
}
function pages(value: unknown): ObjectValue[] {
  if (!Array.isArray(value) || !value.every(Array.isArray)) throw new Error('Invalid paginated evidence');
  return value.flat().map(object);
}
export interface ProductionRow {
  number: number; lane: string; merged: boolean; released: Evidence; published: Evidence;
  releases: string[];
}
export interface ProductionGroup {
  repo: string; lane: string; total: number; merged: number; released: number; published: number;
  releaseUnknown: number; publicationUnknown: number; productionShare: number | null;
}

/** Reads root manifests at the exact release tag. Never infers publication from tag names. */
async function publication(repo: string, tag: string, reads: ProductionReads): Promise<Evidence> {
  let found = false;
  let unknown = false;
  for (const path of ['package.json', 'Cargo.toml']) {
    try {
      const response = await reads.github(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(tag)}`);
      if (response === null) continue;
      const content = object(response);
      if (content.encoding !== 'base64' || typeof content.content !== 'string') throw new Error('Invalid manifest');
      const text = Buffer.from(content.content, 'base64').toString('utf8');
      const manifest = object(path === 'package.json' ? JSON.parse(text) : parseToml(text));
      if (path === 'Cargo.toml' && !manifest.package) continue;
      const pkg = path === 'Cargo.toml' ? object(manifest.package) : manifest;
      if (pkg.private === true || pkg.publish === false) continue;
      if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new Error('Unresolved package');
      found = true;
      const url = path === 'package.json'
        ? `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`
        : `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
      const result = await reads.registry(url);
      if (result === null) continue;
      const record = object(result);
      const version = path === 'package.json' ? record : object(record.version);
      if ((path === 'package.json' ? version.name === pkg.name && version.version === pkg.version
        : version.crate === pkg.name && version.num === pkg.version && version.yanked === false)) return 'yes';
      unknown = true;
    } catch { unknown = true; }
  }
  return unknown || !found ? 'unknown' : 'no';
}

export async function collectProduction(repo: string, reads: ProductionReads = productionReads,
  bridgeLabel = 'bridge', laneFilter?: string) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo)) throw new Error('Expected owner/repo');
  const pulls = pages(await reads.github(`repos/${repo}/pulls?state=all&per_page=100`, true));
  let releases: ObjectValue[] = [];
  let releaseUnavailable = false;
  try {
    releases = pages(await reads.github(`repos/${repo}/releases?per_page=100`, true))
      .filter(release => release.draft === false && release.prerelease === false);
  } catch { releaseUnavailable = true; }
  const published = new Map<string, Promise<Evidence>>();
  const tags = new Map<string, Promise<string>>();
  const rows: ProductionRow[] = [];
  for (const pr of pulls) {
    const labels = Array.isArray(pr.labels) ? pr.labels.map(label => object(label).name).filter((v): v is string => typeof v === 'string') : [];
    const branch = object(pr.head).ref;
    if (!labels.includes(bridgeLabel) && !(typeof branch === 'string' && branch.startsWith('bridge/'))) continue;
    const lanes = labels.filter(label => label.startsWith('lane:')).map(label => label.slice(5).trim()).filter(Boolean);
    const lane = lanes.length === 1 ? lanes[0] : 'unknown';
    if (laneFilter && lane !== laneFilter) continue;
    if (typeof pr.number !== 'number') throw new Error('Invalid PR number');
    const row: ProductionRow = { number: pr.number, lane, merged: typeof pr.merged_at === 'string',
      released: 'no', published: 'no', releases: [] };
    rows.push(row);
    if (!row.merged) continue;
    let uncertain = releaseUnavailable;
    const states: Evidence[] = [];
    for (const release of releases) {
      if (typeof release.tag_name !== 'string' || typeof pr.merge_commit_sha !== 'string') { uncertain = true; continue; }
      const tag = release.tag_name;
      try {
        // Resolve both lightweight and annotated tags once and pin all evidence to that commit.
        if (!tags.has(tag)) tags.set(tag, reads.github(`repos/${repo}/commits/${encodeURIComponent(tag)}`).then(value => {
          const sha = object(value).sha;
          if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid tag commit');
          return sha;
        }));
        const commit = await tags.get(tag)!;
        const comparison = object(await reads.github(`repos/${repo}/compare/${encodeURIComponent(pr.merge_commit_sha)}...${commit}`));
        if (!['ahead', 'identical', 'behind', 'diverged'].includes(String(comparison.status))) throw new Error('Invalid comparison');
        if (comparison.status !== 'ahead' && comparison.status !== 'identical') continue;
        row.releases.push(tag);
        if (!published.has(tag)) published.set(tag, publication(repo, commit, reads));
        states.push(await published.get(tag)!);
      } catch { uncertain = true; }
    }
    row.released = row.releases.length ? 'yes' : uncertain ? 'unknown' : 'no';
    row.published = states.includes('yes') ? 'yes' : uncertain || states.includes('unknown') ? 'unknown' : 'no';
  }
  const groups: ProductionGroup[] = [];
  for (const lane of [...new Set(rows.map(row => row.lane))].sort()) {
    const selected = rows.filter(row => row.lane === lane);
    const count = (key: 'released' | 'published', value: Evidence) => selected.filter(row => row[key] === value).length;
    groups.push({ repo, lane, total: selected.length, merged: selected.filter(row => row.merged).length,
      released: count('released', 'yes'), published: count('published', 'yes'),
      releaseUnknown: count('released', 'unknown'), publicationUnknown: count('published', 'unknown'),
      productionShare: selected.length ? count('published', 'yes') / selected.length : null });
  }
  return { repo, groups, rows };
}
