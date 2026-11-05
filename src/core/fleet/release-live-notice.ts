import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

export type ReleaseFact = { repo: string; tag: string; publishedAt: string; url: string; draft: boolean; prerelease: boolean };
export type ReleaseRunner = (argv: string[]) => Promise<{ code: number; stdout: string }>;
export const validReleaseRepo = (repo: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
const execFileAsync = promisify(execFile);
const hasUnsafeChars = (value: string): boolean => [...value].some(char => /\s/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const defaultRun: ReleaseRunner = async argv => {
  try { const { stdout } = await execFileAsync('gh', argv); return { code: 0, stdout }; }
  catch { return { code: 1, stdout: '' }; }
};

export async function fetchLatestRelease(repo: string, run: ReleaseRunner = defaultRun, tag?: string): Promise<ReleaseFact | null> {
  if (!validReleaseRepo(repo)) return null;
  try {
    const result = await run(['api', tag ? `repos/${repo}/releases/tags/${encodeURIComponent(tag)}` : `repos/${repo}/releases/latest`]);
    if (result.code !== 0) return null;
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (typeof row.tag_name !== 'string' || !row.tag_name || hasUnsafeChars(row.tag_name)
      || typeof row.published_at !== 'string' || !Number.isFinite(Date.parse(row.published_at))
      || typeof row.html_url !== 'string' || hasUnsafeChars(row.html_url)
      || typeof row.draft !== 'boolean' || typeof row.prerelease !== 'boolean') return null;
    const url = new URL(row.html_url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return null;
    return { repo, tag: row.tag_name, publishedAt: row.published_at, url: row.html_url, draft: row.draft, prerelease: row.prerelease };
  } catch { return null; }
}

export const releaseKey = (fact: ReleaseFact): string => `${fact.repo}@${fact.tag}`;
export function planReleaseNotices(facts: readonly (ReleaseFact | null)[], sentKeys: ReadonlySet<string>): ReleaseFact[] {
  const seen = new Set(sentKeys);
  return facts.filter((fact): fact is ReleaseFact => {
    if (!fact || fact.draft || seen.has(releaseKey(fact))) return false;
    seen.add(releaseKey(fact));
    return true;
  });
}

export function readReleaseLedger(runsDir: string): { exists: boolean; sent: Set<string> } {
  let text: string;
  try { text = readFileSync(join(runsDir, 'leader', 'release-live-sent.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, sent: new Set() }; throw error; }
  const sent = new Set<string>();
  for (const line of text.split('\n')) {
    try { const row: unknown = JSON.parse(line); if (row && typeof row === 'object' && 'key' in row && typeof row.key === 'string') sent.add(row.key); }
    catch { /* Incomplete records do not suppress retries. */ }
  }
  return { exists: true, sent };
}

const append = (path: string, text: string): void => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { appendFileSync(fd, text); } finally { closeSync(fd); }
};
export function writeReleaseNotices(notices: readonly ReleaseFact[], runsDir: string, now: Date, baseline = false): void {
  const leader = join(runsDir, 'leader');
  mkdirSync(leader, { recursive: true, mode: 0o700 });
  const ledger = join(leader, 'release-live-sent.jsonl');
  for (const notice of notices) {
    if (!baseline) append(join(leader, 'MASON-OUTBOX.md'), `\n## ${now.toISOString()} Release live: ${notice.repo} ${notice.tag}\n\n${notice.repo} ${notice.tag} is released and published (${notice.url}).\n`);
    append(ledger, `\n${JSON.stringify({ key: releaseKey(notice) })}\n`);
  }
  if (baseline && notices.length === 0) append(ledger, '');
}


export type MilestoneStage = 'published' | 'feed-ready' | 'installed';
export interface MilestoneEvidence { repo: string; version: string; observedAt: string }
export interface MilestoneObservation {
  stage: MilestoneStage; status: 'observed' | 'unknown'; repo: string; tag: string;
  version: string | null; source: string; observedAt: string | null; reason: string | null;
}
export type MilestoneReader = (repo: string, tag: string) => Promise<MilestoneEvidence | null>;

// SemVer precedence ignores build metadata and compares numeric prerelease identifiers numerically.
function semver(value: string): { core: bigint[]; pre: string[] } | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!m || m[4]?.split('.').some(x => /^\d+$/.test(x) && x.length > 1 && x.startsWith('0'))) return null;
  return { core: [BigInt(m[1]!), BigInt(m[2]!), BigInt(m[3]!)], pre: m[4]?.split('.') ?? [] };
}
export function validMilestoneTag(tag: string): boolean { return tag.length <= 128 && semver(tag) !== null; }
function atLeast(actual: string, requested: string): boolean {
  const a = semver(actual), b = semver(requested); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]!;
  if (!a.pre.length || !b.pre.length) return !a.pre.length || !!b.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]; if (x === undefined || y === undefined) return y === undefined;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    return xn !== yn ? !xn : x > y;
  }
  return true;
}

/** Public availability only; this does not verify or install the updater artifact. */
export const readPublicReleaseFeed: MilestoneReader = async repo => {
  if (repo.toLowerCase() !== 'ashlrai/phantom') return null;
  try {
    const response = await fetch('https://github.com/ashlrai/phantom/releases/latest/download/latest.json', { signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body || !/^https:\/\/(?:github\.com|release-assets\.githubusercontent\.com)\//.test(response.url)) return null;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024) { await reader.cancel(); return null; } chunks.push(value); }
    const row = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { version?: unknown; platforms?: Record<string, { url?: unknown; signature?: unknown }> };
    const platform = row.platforms?.['darwin-aarch64'];
    if (typeof row.version !== 'string' || !validMilestoneTag(row.version) || !platform || typeof platform.signature !== 'string' || !platform.signature
      || platform.url !== `https://github.com/ashlrai/phantom/releases/download/v${row.version}/Phantom_${row.version}_aarch64.app.tar.gz`) return null;
    return { repo: 'ashlrai/phantom', version: row.version, observedAt: new Date().toISOString() };
  } catch { return null; }
};

export async function observeMilestones(repo: string, tag: string, fact: ReleaseFact | null, now: Date,
  feed: MilestoneReader = readPublicReleaseFeed, installed?: MilestoneReader): Promise<MilestoneObservation[]> {
  const publication: MilestoneObservation = { stage: 'published', status: 'unknown', repo, tag, version: null, source: 'github-release', observedAt: null, reason: 'release unavailable or mismatched' };
  if (fact && !fact.draft && fact.repo.toLowerCase() === repo.toLowerCase() && fact.tag === tag && Date.parse(fact.publishedAt) <= now.getTime()) {
    Object.assign(publication, { status: 'observed', version: fact.tag, observedAt: fact.publishedAt, reason: null });
  }
  const inspect = async (stage: 'feed-ready' | 'installed', reader: MilestoneReader | undefined, source: string, missing: string): Promise<MilestoneObservation> => {
    const result: MilestoneObservation = { stage, status: 'unknown', repo, tag, version: null, source, observedAt: null, reason: missing };
    if (!reader) return result;
    let evidence: MilestoneEvidence | null = null;
    try { evidence = await reader(repo, tag); } catch { /* A failed read remains retryable. */ }
    if (!evidence) return result;
    const timestamp = Date.parse(evidence.observedAt);
    if (evidence.repo.toLowerCase() !== repo.toLowerCase() || !validMilestoneTag(evidence.version) || !atLeast(evidence.version, tag)) result.reason = 'repository or version mismatch';
    else if (!Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp > 5 * 60 * 1000 || (publication.status === 'observed' && timestamp < Date.parse(fact!.publishedAt))) result.reason = 'stale or invalid observation timestamp';
    else Object.assign(result, { status: 'observed', version: evidence.version, observedAt: evidence.observedAt, reason: null });
    return result;
  };
  return [publication, await inspect('feed-ready', feed, 'public-update-feed', 'feed unavailable or unsupported'),
    await inspect('installed', installed, 'local-installed-version', 'no safe desktop installed-version read contract available')];
}

export function readMilestoneLedger(runsDir: string): Set<string> {
  try {
    const sent = new Set<string>();
    for (const line of readFileSync(join(runsDir, 'leader', 'release-milestones-sent.jsonl'), 'utf8').split('\n')) {
      try { const row: unknown = JSON.parse(line); if (row && typeof row === 'object' && 'key' in row && typeof row.key === 'string') sent.add(row.key); } catch { /* Retry incomplete records. */ }
    }
    return sent;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
}
export const milestoneKey = (observation: MilestoneObservation): string => `${observation.repo.toLowerCase()}@${observation.tag}:${observation.stage}`;
export function writeMilestoneNotices(observations: readonly MilestoneObservation[], runsDir: string, now: Date): void {
  const leader = join(runsDir, 'leader');
  for (const observation of observations) {
    const text = observation.stage === 'published' ? 'is published' : observation.stage === 'feed-ready' ? `has update feed version ${observation.version} available` : `has installed desktop version ${observation.version} observed`;
    append(join(leader, 'MASON-OUTBOX.md'), `\n## ${now.toISOString()} Release ${observation.stage}: ${observation.repo} ${observation.tag}\n\n${observation.repo} ${observation.tag} ${text} (observed ${observation.observedAt}).\n`);
    append(join(leader, 'release-milestones-sent.jsonl'), `\n${JSON.stringify({ key: milestoneKey(observation) })}\n`);
  }
}
