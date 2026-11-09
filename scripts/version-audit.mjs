/** Anonymous, read-only fleet version audit. No account tools or write operations. */
import { parse } from 'smol-toml';
import { pathToFileURL } from 'node:url';

const EXTRA_MANIFESTS = {
  'phantom-secrets': ['crates/phantom-cli/Cargo.toml', 'crates/phantom-mcp/Cargo.toml', 'npm/package.json', 'npm-mcp/package.json'],
  locus: ['crates/locus-cli/Cargo.toml', 'crates/locus-mcp/Cargo.toml', 'npm/package.json', 'npm-mcp/package.json'],
  'ashlr-stack': ['packages/cli/package.json', 'packages/core/package.json', 'packages/mcp/package.json'],
};

export const REPOSITORIES = Object.freeze([
  'phantom', 'phantom-secrets', 'locus', 'lexicon',
  'ashlr-stack', 'ashlr-cortex', 'ashlr-md',
]);

// Stable releases only. Build metadata does not affect precedence.
export function stableVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return match?.[1] ?? null;
}
export function latest(values) {
  return values.map(stableVersion).filter(Boolean).sort((a, b) => {
    const av = a.split('.').map(BigInt);
    const bv = b.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) {
      if (av[i] !== bv[i]) return av[i] > bv[i] ? -1 : 1;
    }
    return 0;
  })[0] ?? null;
}

export function manifest(text, kind, workspace = {}) {
  const data = kind === 'npm' ? JSON.parse(text) : parse(text);
  const pkg = kind === 'npm' ? data : data.package ?? (data.workspace?.package ? { ...data.workspace.package, name: '(workspace)', publish: false } : null);
  if (!pkg) throw new Error('missing package');
  const version = typeof pkg.version === 'object' && pkg.version?.workspace === true
    ? (data.workspace?.package?.version ?? workspace.version) : pkg.version;
  if (typeof pkg.name !== 'string' || typeof version !== 'string') throw new Error('invalid package');
  return { name: pkg.name, version, private: pkg.private === true || pkg.publish === false || (pkg.publish?.workspace === true && workspace.publish === false) };
}

// Only explicit badge contexts count. Ordinary prose and dependency versions do not.
export function badgeVersions(html) {
  const values = [];
  for (const match of html.matchAll(/data-version\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  for (const match of html.matchAll(/(?:alt|aria-label)\s*=\s*["'](?:version|release)\s*[: ]\s*(v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?)["']/gi)) values.push(match[1]);
  for (const match of html.matchAll(/img\.shields\.io\/badge\/(?:version|release)-v?(\d+\.\d+\.\d+)(?:-|\?|["'])/gi)) values.push(match[1]);
  return [...new Set(values.map(stableVersion).filter(Boolean))];
}

/** Scope shared catalog badges to the repository's own card or structured data. */
export function catalogBadges(html, repo) {
  const repository = `https://github.com/ashlrai/${repo}`;
  const values = [];
  for (const match of html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)) {
    if (match[0].includes(`"${repository}"`)) values.push(...badgeVersions(match[0]));
  }
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.codeRepository === repository && stableVersion(node.softwareVersion)) values.push(stableVersion(node.softwareVersion));
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === 'object') visit(child);
      }
    };
    // Malformed structured data cannot establish a badge observation.
    try { visit(JSON.parse(match[1])); } catch { /* Other cards can still provide evidence. */ }
  }
  return [...new Set(values)];
}

export function registryBelongsTo(value, repo) {
  const location = typeof value === 'string' ? value : value?.url;
  if (typeof location !== 'string') return false;
  const normalized = location.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/');
  try {
    const url = new URL(normalized);
    return url.hostname.toLowerCase() === 'github.com' &&
      url.pathname.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase() === `/ashlrai/${repo}`;
  } catch { return false; }
}

/** Bounded requests, no credentials, no redirects, no response bodies in errors. */
export async function publicRead(url) {
  const response = await globalThis.fetch(url, {
    method: 'GET', redirect: 'error', credentials: 'omit',
    headers: { Accept: 'application/json', 'User-Agent': 'ashlrai-version-audit' },
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return { missing: true };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new Error('response too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

export async function auditRepository(repo, read = publicRead) {
  if (!REPOSITORIES.includes(repo)) throw new Error('repository outside fleet');
  const base = `https://api.github.com/repos/ashlrai/${repo}`;
  const evidence = [];
  async function observe(source, url, extract) {
    try {
      const result = await read(url);
      if (result.missing) {
        evidence.push({ source, url, status: 'missing', version: null });
        return null;
      }
      const value = extract(result.text);
      evidence.push({ source, url, status: value ? 'ok' : 'unknown', version: value });
      return value;
    } catch (error) {
      evidence.push({ source, url, status: 'error', version: null,
        ...(error.message === 'registry identity unverified' ? { reason: 'registry identity unverified' } : {}),
      });
      return null;
    }
  }
  let pkg;
  let kind;
  let workspace = {};
  const packages = [];
  for (const candidate of ['npm', 'cargo']) {
    const file = candidate === 'npm' ? 'package.json' : 'Cargo.toml';
    const url = `${base}/contents/${file}`;
    const version = await observe(`manifest:${candidate}`, url, (body) => {
      const data = JSON.parse(body);
      if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('invalid contents');
      const parsed = manifest(Buffer.from(data.content, 'base64').toString('utf8'), candidate);
      pkg = parsed;
      if (candidate === 'cargo') workspace = parse(Buffer.from(data.content, 'base64').toString('utf8')).workspace?.package ?? {};
      return parsed.version;
    });
    if (version) { kind = candidate; break; }
  }
  // Paginate both collections. A cap is incomplete evidence, never a clean audit.
  for (const source of ['tags', 'releases']) {
    const versions = [];
    let complete = false;
    for (let page = 1; page <= 20; page++) {
      const url = `${base}/${source}?per_page=100&page=${page}`;
      try {
        const result = await read(url);
        if (result.missing) throw new Error('missing collection');
        const rows = JSON.parse(result.text);
        if (!Array.isArray(rows)) throw new Error('invalid collection');
        for (const row of rows) {
          if (source === 'tags' || (!row.draft && !row.prerelease)) versions.push(source === 'tags' ? row.name : row.tag_name);
        }
        if (rows.length < 100) { complete = true; break; }
      } catch { break; }
    }
    evidence.push({ source, url: `${base}/${source}`, status: complete ? (latest(versions) ? 'ok' : 'missing') : 'error', version: complete ? latest(versions) : null });
  }
  if (pkg) packages.push({ ...pkg, kind, source: `manifest:${kind}` });
  for (const file of EXTRA_MANIFESTS[repo] ?? []) {
    const candidate = file.endsWith('Cargo.toml') ? 'cargo' : 'npm';
    const source = `manifest:${file}`;
    await observe(source, `${base}/contents/${file}`, (body) => {
      const data = JSON.parse(body);
      if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('invalid contents');
      const parsed = manifest(Buffer.from(data.content, 'base64').toString('utf8'), candidate, workspace);
      packages.push({ ...parsed, kind: candidate, source });
      return parsed.version;
    });
  }
  // A private monorepo root has its own bookkeeping version. Use its CLI instead.
  if (repo === 'ashlr-stack') pkg = packages.find((item) => item.source === 'manifest:packages/cli/package.json');
  for (const entry of packages.filter((item) => !item.private)) {
    const url = entry.kind === 'npm' ? `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/latest`
      : `https://crates.io/api/v1/crates/${encodeURIComponent(entry.name)}`;
    await observe(entry.kind + (packages.length > 1 ? `:${entry.name}` : ''), url, (text) => {
      const data = JSON.parse(text);
      if (!registryBelongsTo(entry.kind === 'npm' ? data.repository : data.crate?.repository, repo)) throw new Error('registry identity unverified');
      return stableVersion(entry.kind === 'npm' ? data.version : data.crate?.max_stable_version);
    });
  }
  const pageUrl = 'https://ashlr.ai/developer-tools';
  let badges = [];
  await observe('badges', pageUrl, (html) => {
    badges = catalogBadges(html, repo);
    return badges.length ? badges.join(',') : null;
  });
  const release = evidence.find((item) => item.source === 'releases')?.version;
  const reference = stableVersion(pkg?.version);
  const drift = evidence.filter((item) => item.status === 'ok' && item.source !== 'badges' && !(repo === 'ashlr-stack' && item.source === 'manifest:npm') && reference && stableVersion(item.version) !== reference)
    .map((item) => ({ source: item.source, expected: reference, actual: item.version }));
  for (const version of badges) {
    if (release && version !== release) drift.push({ source: 'badges', expected: release, actual: version });
  }
  const unknown = evidence.filter((item) => item.status !== 'ok' && !(item.source === 'manifest:npm' && kind === 'cargo' && item.status === 'missing'));
  if (!reference) unknown.push({ source: 'stable-manifest', status: 'unknown' });
  return {
    repo: `ashlrai/${repo}`, status: unknown.length ? 'incomplete' : drift.length ? 'drift' : 'aligned',
    package: pkg ?? null, packages, evidence, drift, unknown,
    repairSuggestions: drift.filter((item) => item.source === 'badges').map((item) => ({
      scope: ['docs', 'badges', 'changelog'], action: 'review-docs-only-pr',
      url: pageUrl, from: item.actual, to: item.expected,
    })),
  };
}

export async function auditFleet(read = publicRead) {
  const repositories = [];
  const cache = new Map();
  const cachedRead = (url) => {
    if (!cache.has(url)) cache.set(url, Promise.resolve().then(() => read(url)));
    return cache.get(url);
  };
  // Sequential requests stay within anonymous API limits and preserve report ordering.
  for (const repo of REPOSITORIES) repositories.push(await auditRepository(repo, cachedRead));
  return { schemaVersion: 1, observedAt: new Date().toISOString(), toolsUsed: [],
    policy: { readOnly: true, stableOnly: true, reference: 'manifest; badges compare to latest stable GitHub Release' },
    repositories, summary: {
      aligned: repositories.filter((r) => r.status === 'aligned').length,
      drift: repositories.reduce((sum, r) => sum + r.drift.length, 0),
      incomplete: repositories.filter((r) => r.status === 'incomplete').length,
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: node scripts/version-audit.mjs\n');
    process.exitCode = 2;
  } else {
    const report = await auditFleet();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.summary.incomplete ? 2 : report.summary.drift ? 1 : 0;
  }
}
