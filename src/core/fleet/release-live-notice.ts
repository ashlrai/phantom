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

export async function fetchLatestRelease(repo: string, run: ReleaseRunner = defaultRun): Promise<ReleaseFact | null> {
  if (!validReleaseRepo(repo)) return null;
  try {
    const result = await run(['api', `repos/${repo}/releases/latest`]);
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
    if (!baseline) append(join(leader, 'MASON-OUTBOX.md'), `\n## ${now.toISOString()} Release live: ${notice.repo} ${notice.tag}\n\n${notice.repo} ${notice.tag} is published (${notice.url}). The installed app picks it up through self-update.\n`);
    append(ledger, `\n${JSON.stringify({ key: releaseKey(notice) })}\n`);
  }
  if (baseline && notices.length === 0) append(ledger, '');
}
