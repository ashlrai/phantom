import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NOTE_GROUPS = ['New', 'Improved', 'Fixed', 'Internal'] as const;
type NoteGroup = typeof NOTE_GROUPS[number];
export interface ReleaseChange { text: string; prs: number[]; commits: string[] }
export interface ReleaseNotes {
  schema: 'phantom.release-notes.v1'; since: string; head: string; summary: string[];
  groups: Record<NoteGroup, ReleaseChange[]>;
}
export interface NoteCommit { sha: string; author: string; subject: string; files: string[] }
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const internal = (file: string): boolean => /^(test\/|scripts\/|\.github\/)|(?:^|\/)(?:[^/]*\.test\.[^/]+|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|BRIDGE_NOTES\.md)$/.test(file);
const safeText = (text: string): string => text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
const markdown = (text: string): string => text.replace(/[\\`*_[\]<>]/g, '\\$&');

/** NUL-separated fields and filenames; record separators delimit Git commits. */
export function parseNotesLog(log: string): NoteCommit[] {
  return log.split('\x1e').filter(part => part.trim()).map(part => {
    const [sha, author, subject, body, ...files] = part.split('\0');
    if (!sha || !author || !subject || !/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid Git log');
    const merge = subject.match(/^Merge pull request #(\d+)\b/);
    const title = merge ? `${body?.trim().split('\n')[0] || 'bridge:'} (#${merge[1]})` : subject;
    return { sha, author, subject: title, files: files.map(file => file.replace(/^\n/, '')).filter(Boolean) };
  });
}

export function buildReleaseNotes(since: string, head: string, commits: NoteCommit[]): ReleaseNotes {
  const groups: ReleaseNotes['groups'] = { New: [], Improved: [], Fixed: [], Internal: [] };
  const seen = new Map<string, ReleaseChange>();
  const recut = (subject: string) => subject.match(/(?:recut(?: of)?|supersedes)\s+#(\d+)/i)?.[1];
  const pull = (subject: string) => subject.match(/\(#(\d+)\)\s*$/)?.[1];
  const redirects = new Map(commits.map(commit => [pull(commit.subject), recut(commit.subject)]));
  for (const commit of [...commits].sort((a, b) => Number(!!recut(a.subject)) - Number(!!recut(b.subject)) || compare(a.sha, b.sha))) {
    const subject = safeText(commit.subject);
    if (/^Merge\b/i.test(subject) || (/\[bot\]|\bbot\b|dependabot|renovate/i.test(commit.author) && /^(?:chore|ci|build)(?:\(|:)/i.test(subject))) continue;
    const pr = pull(subject);
    let original = recut(subject);
    const chain = new Set<string>();
    while (original && redirects.get(original) && !chain.has(original)) { chain.add(original); original = redirects.get(original); }
    let text = subject.replace(/\s*\(#\d+\)\s*$/, '');
    const kind = text.match(/(?:^|:\s*)(feat|fix|perf|refactor|docs|test|chore|ci|build)(?:\([^)]*\))?!?:/i)?.[1]?.toLowerCase();
    // Remove transport/job labels, retaining the actual description when present.
    for (let i = 0; i < 4; i++) text = text
      .replace(/^(?:[a-z]+(?:\([^)]*\))?!?:|RQ-[A-Z0-9-]+\b[:\s—-]*|BRIDGE_NOTES\s*[:—-]?\s*|bridge notes\s*[:—-]?\s*|recut(?: of)?(?:\s+#\d+)?\s*[:—-]?\s*)/i, '')
      .replace(/\s*\(recut(?:\s+[^)]*)?\)\s*$/i, '').trim();
    text = text.replace(/^[-*]\s+/, '').trim();
    const descriptive = !!text && !/^(?:(?:supersedes|continuation of)\s+#\d+|FIXUP-CI-\S+|handoff|partial source handoff;?\s*uncommitted)\s*$/i.test(text)
      && !/\b[a-z]$|[-—]$/.test(text) && (text.match(/\(/g)?.length ?? 0) === (text.match(/\)/g)?.length ?? 0);
    const files = [...commit.files].sort(compare);
    if (!descriptive) {
      const file = files.find(file => file.startsWith('src/') && !internal(file)) ?? files.find(file => !internal(file)) ?? files[0];
      const area = file?.replace(/^src\/(?:core|cli)\//, '').replace(/\.[^.]+$/, '').replace(/[/_-]+/g, ' ');
      text = area ? `Update ${safeText(area)}` : 'Update project internals';
    }
    text = text.charAt(0).toUpperCase() + text.slice(1).replace(/\.$/, '');
    const key = descriptive ? text.toLowerCase() : `pr:${original ?? pr ?? commit.sha}`;
    const prior = seen.get(key) ?? seen.get(`pr:${original ?? pr}`);
    if (prior) {
      if (pr) prior.prs.push(Number(pr));
      prior.commits.push(commit.sha);
      if (pr) seen.set(`pr:${pr}`, prior);
      continue;
    }
    const group: NoteGroup = files.length && files.every(internal) ? 'Internal'
      : kind === 'fix' || /^(?:fix|repair|prevent|restore|correct)\b/i.test(text) ? 'Fixed'
        : kind === 'feat' || /^(?:add|introduce|enable)\b/i.test(text) ? 'New'
          : /^(?:test|chore|ci|build)$/.test(kind ?? '') ? 'Internal' : 'Improved';
    const change = { text, prs: pr ? [Number(pr)] : [], commits: [commit.sha] };
    groups[group].push(change); seen.set(key, change);
    if (pr) seen.set(`pr:${pr}`, change);
    if (original) seen.set(`pr:${original}`, change);
  }
  for (const group of NOTE_GROUPS) {
    for (const change of groups[group]) {
      change.prs = [...new Set(change.prs)].sort((a, b) => a - b);
      change.commits = [...new Set(change.commits)].sort(compare);
    }
    groups[group].sort((a, b) => compare(a.text, b.text) || compare(a.commits[0]!, b.commits[0]!));
  }
  const count = NOTE_GROUPS.reduce((total, group) => total + groups[group].length, 0);
  const summary = count ? [`${count} changes since ${since}.`, `${groups.New.length} new, ${groups.Improved.length} improved, ${groups.Fixed.length} fixed, ${groups.Internal.length} internal.`]
    : [`Nothing new since ${since}`];
  if (count) summary.push(`Highlights: ${[...groups.New, ...groups.Fixed, ...groups.Improved, ...groups.Internal].slice(0, 2).map(change => change.text).join('; ')}.`);
  return { schema: 'phantom.release-notes.v1', since, head, summary, groups };
}

export function collectReleaseNotes(directory = process.cwd(), since?: string, ref = 'HEAD'): ReleaseNotes {
  const git = (...args: string[]): string => {
    try { return execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { throw new Error('Cannot read Git history; check the repository and tag'); }
  };
  const head = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  since ??= git('tag', '--merged', head, '--sort=-version:refname').split('\n').find(tag => /^v?\d+\.\d+\.\d+$/.test(tag));
  if (!since) throw new Error('No release tag found; use --since <tag>');
  if (!/^[\w][\w./-]*$/.test(since)) throw new Error('Invalid release tag');
  const base = git('rev-parse', '--verify', '--end-of-options', `refs/tags/${since}^{commit}`).trim();
  // A shallow clone is sufficient only when its mainline reaches the base tag.
  if (!git('rev-list', '--first-parent', head).split('\n').includes(base)) throw new Error('Release tag is not on the available mainline; fetch history and tags');
  const log = git('log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--no-ext-diff', '--format=%x1e%H%x00%an%x00%s%x00%b%x00', '--name-only', '-z', `${base}..${head}`, '--');
  return buildReleaseNotes(since, head, parseNotesLog(log));
}

export function formatReleaseNotes(notes: ReleaseNotes, changelog = false): string {
  const headings = { New: 'Added', Improved: 'Changed', Fixed: 'Fixed', Internal: 'Internal' };
  return notes.summary.map(markdown).join('\n') + '\n' + NOTE_GROUPS.map(group => notes.groups[group].length
    ? `\n### ${changelog ? headings[group] : group}\n\n${notes.groups[group].map(change => `- ${markdown(change.text)} (${change.prs.length ? change.prs.map(pr => `#${pr}`).join(', ') : change.commits[0]!.slice(0, 8)}).`).join('\n')}\n` : '').join('');
}

/** Replace only our generated block; historical and hand-written entries stay intact. */
export function writeReleaseNotes(directory: string, notes: ReleaseNotes): void {
  const path = join(directory, 'CHANGELOG.md');
  if (!lstatSync(path).isFile()) throw new Error('CHANGELOG.md must be a regular file');
  const source = readFileSync(path, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const section = /^## \[Unreleased\]\r?\n/m.exec(source);
  if (!section || section.index !== source.search(/^## /m)) throw new Error('CHANGELOG.md must start with an Unreleased section');
  const start = section.index + section[0].length;
  const end = source.indexOf(`${newline}## `, start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const begin = '<!-- release-notes:start -->', finish = '<!-- release-notes:end -->';
  const old = body.match(/\r?\n<!-- release-notes:start -->[\s\S]*?<!-- release-notes:end -->\r?\n/);
  if ((body.includes(begin) || body.includes(finish)) && (!old || body.split(begin).length !== 2 || body.split(finish).length !== 2)) throw new Error('Invalid generated release notes block');
  const block = `${newline}${begin}${newline}${formatReleaseNotes(notes, true).replace(/\n/g, newline)}${finish}${newline}`;
  writeFileSync(path, source.slice(0, start) + block + body.replace(old?.[0] ?? /$^/, '') + source.slice(end < 0 ? source.length : end));
}
