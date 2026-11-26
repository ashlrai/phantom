/**
 * Release notes from merged pull requests (`phm release notes --repo <name>`).
 *
 * Agent commit subjects are all `bridge(RQ-...)`, so git history says little. The
 * plain-words description lives in each PR's title and body, so this reads those.
 * The GitHub call sits behind `PrSource`; tests pass fixtures, the CLI passes `ghPrSource`.
 */
import { runGhAttempt, type GhRunFailure, type GhRunResult } from '../integrations/github.js';
import { backlogScanContext } from '../portfolio/scan-snapshot.js';
import { internal } from './notes.js';

export const PR_NOTES_SCHEMA = 'phantom.release-notes-prs.v1';
export const NOTE_SECTIONS = ['Added', 'Changed', 'Fixed', 'Security'] as const;
export type NoteSectionName = typeof NOTE_SECTIONS[number];
export const NOTHING_TO_RELEASE = 'Nothing to release.';
/** Shown when a PR has no readable title or body. Never guessed; also listed under `unknown`. */
export const UNKNOWN_CHANGE = 'Change details unknown';

/** One merged PR as read from GitHub. `files` is absent when the source could not list them. */
export interface MergedPr { number: number; title: string; body: string; mergedAt?: string; files?: string[] }
/** Result of a read. `complete` is false when the source hit a page limit. */
export interface MergedPrs { prs: MergedPr[]; complete: boolean }
export interface PrSource {
  /** Merged PRs after tag `since` in `repo` (`owner/name`, or the current repository when undefined). */
  mergedSince(repo: string | undefined, since: string): Promise<MergedPrs>;
}
export interface PrNoteLine { text: string; prs: number[] }
export interface PrReleaseNotes {
  schema: typeof PR_NOTES_SCHEMA;
  repo: string | null;
  since: string;
  summary: string;
  sections: Record<NoteSectionName, PrNoteLine[]>;
  /** PRs dropped as internal-only (tests, CI, bridge bookkeeping). */
  skipped: number[];
  /** PRs whose title and body gave no readable change. They still appear as "Change details unknown". */
  unknown: number[];
  /** False when the PR list was cut off, so notes may be missing changes. */
  complete: boolean;
}

const KINDS = 'feat|fix|perf|refactor|docs|test|chore|ci|build|style|revert|security';
/** Remove transport labels: `bridge(RQ-X):`, `RQ-X:`, `feat(scope):`, a trailing `(#12)`. Returns the kind too. */
function cleanTitle(title: string): { text: string; kind?: string } {
  let text = title.replace(/\s+/g, ' ').trim().replace(/\s*\(#\d+\)\s*$/, '');
  let kind: string | undefined;
  for (let i = 0; i < 4; i++) {
    const before = text;
    const typed = text.match(new RegExp(`^(${KINDS})(?:\\([^)]*\\))?!?:\\s*`, 'i'));
    if (typed) { kind ??= typed[1]!.toLowerCase(); text = text.slice(typed[0].length); }
    text = text.replace(/^(?:bridge|codex-bridge)(?:\([^)]*\))?\s*:\s*/i, '').replace(/^RQ-[A-Z0-9-]+\b\s*[:—-]?\s*/i, '').trim();
    if (text === before) break;
  }
  return { text, kind };
}

/** First readable sentence from a "Summary", "What changed" or BRIDGE_NOTES section of a PR body. */
function bodyLine(body: string): string | undefined {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const heading = /^#{1,4}\s*(?:summary|what(?:'s| has)? changed|what's new|release notes?|bridge[_ ]notes)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i]!)) continue;
    for (const raw of lines.slice(i + 1)) {
      if (/^#{1,6}\s/.test(raw)) break;
      const line = plain(raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
      if (line && !/:$/.test(line) && !/^RQ-[A-Z0-9-]+$/i.test(line) && /[a-z]{3}/i.test(line)) return line;
    }
  }
  return undefined;
}

/** One reader-facing line: no job ids, PR numbers, hashes or markdown marks. */
function plain(text: string): string {
  let out = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_>]/g, '').replace(/#\d+|\bRQ-[A-Z0-9-]+|\b[a-f0-9]{9,40}\b/gi, ' ')
    .replace(/\p{Cc}/gu, ' ').replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (out.length > 140) out = out.slice(0, 140).replace(/\s+\S*$/, '');
  out = out.replace(/[\s.,;:-]+$/, '');
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}

const BOOKKEEPING = /^(?:BRIDGE_NOTES\b|FIXUP-CI\b|hand-?off\b|supersedes\b|recut\b)/i;
const SECURITY = /\b(?:security|vulnerab\w*|CVE-\d+|XSS|SSRF|CSRF|injection|path traversal|exploit\w*|leak(?:s|ed|ing)?|redact\w*|privilege escalation|credential\w*)\b/i;
const FIX = /^(?:fix|repair|prevent|restore|correct|stop|resolve|handle)\b/i;
const ADD = /^(?:add|introduce|enable|new|support|ship)\b/i;

/** Internal-only: tests, CI, build bookkeeping or bridge notes. User-visible changes are kept. */
function isInternal(pr: MergedPr, text: string, kind?: string): boolean {
  if (kind && /^(?:test|ci|build|chore|style)$/.test(kind)) return true;
  if (BOOKKEEPING.test(text)) return true;
  return !!pr.files?.length && pr.files.every(internal);
}

function sectionOf(text: string, kind: string | undefined): NoteSectionName {
  if (kind === 'security' || SECURITY.test(text)) return 'Security';
  if (kind === 'fix' || FIX.test(text)) return 'Fixed';
  if (kind === 'feat' || ADD.test(text)) return 'Added';
  return 'Changed';
}

/** Turn merged PRs into grouped plain-words notes. Pure: no network, no clock. */
export function buildPrNotes(repo: string | undefined, since: string, source: MergedPrs): PrReleaseNotes {
  const sections: PrReleaseNotes['sections'] = { Added: [], Changed: [], Fixed: [], Security: [] };
  const skipped: number[] = [], unknown: number[] = [];
  const lines = new Map<string, PrNoteLine>();
  for (const pr of [...source.prs].sort((a, b) => a.number - b.number)) {
    const title = cleanTitle(pr.title);
    if (isInternal(pr, title.text, title.kind)) { skipped.push(pr.number); continue; }
    // The body's own summary is the better wording; the cleaned title is the fallback.
    let text = bodyLine(pr.body) ?? plain(title.text);
    if (!text) { text = UNKNOWN_CHANGE; unknown.push(pr.number); }
    const section = text === UNKNOWN_CHANGE ? 'Changed' : sectionOf(text, title.kind);
    const key = `${section}\0${text.toLowerCase()}`;
    const line = lines.get(key);
    if (line) line.prs.push(pr.number);
    else { const created = { text, prs: [pr.number] }; lines.set(key, created); sections[section].push(created); }
  }
  const count = NOTE_SECTIONS.reduce((sum, name) => sum + sections[name].length, 0);
  const summary = count ? `${count} ${count === 1 ? 'change' : 'changes'} since ${since}.` : NOTHING_TO_RELEASE;
  return { schema: PR_NOTES_SCHEMA, repo: repo ?? null, since, summary, sections, skipped, unknown, complete: source.complete };
}

const escape = (text: string): string => text.replace(/[\\`*_[\]<>]/g, '\\$&');

/** A CHANGELOG.md section ready to paste. Unknown wording is marked, never guessed. */
export function formatPrNotesMarkdown(notes: PrReleaseNotes): string {
  if (notes.summary === NOTHING_TO_RELEASE) return `${NOTHING_TO_RELEASE}\n`;
  const out = ['## Unreleased'];
  for (const name of NOTE_SECTIONS) {
    if (!notes.sections[name].length) continue;
    out.push('', `### ${name}`, '');
    for (const line of notes.sections[name]) out.push(`- ${escape(line.text)} (${line.prs.map(pr => `#${pr}`).join(', ')})`);
  }
  if (!notes.complete) out.push('', '<!-- The PR list was cut off; some changes may be missing. -->');
  return `${out.join('\n')}\n`;
}

const REPO = /^(?:[A-Za-z0-9][A-Za-z0-9-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAG = /^[\w][\w./-]*$/;
const DEFAULT_OWNER = 'ashlrai';
const PAGE = 200;

/** `phantom` means `ashlrai/phantom`; `owner/name` is used as given. */
export function resolveRepo(name: string): string {
  if (!REPO.test(name)) throw new Error('Invalid repo name; use <name> or <owner>/<name>');
  return name.includes('/') ? name : `${DEFAULT_OWNER}/${name}`;
}

/** `gh pr list` fetches titles, bodies and file lists for a full page; on a
 * busy repository that legitimately exceeds the default 8 s read deadline
 * (a 200-PR page measured ~9 s on ashlrai/phantom). */
const PR_LIST_TIMEOUT_MS = 30_000;

/** The gh read seam `ghPrSource` runs through: one bounded call returning
 * trimmed stdout or the failure kind. Tests inject a fake; production uses
 * runGhAttempt. */
export type GhRead = (cwd: string, args: string[], timeoutMs?: number) => Promise<GhRunResult>;

/** A failed gh read in words an operator can act on. 'spawn' means gh never
 * ran, 'timeout' means it was killed at the deadline — neither says anything
 * about the repo or tag, so they must not be reported as unreadable refs.
 * 'exit' means gh ran and refused; the repo/tag/auth check text applies. */
function ghReadError(what: string, failure: GhRunFailure, check: string): Error {
  if (failure === 'spawn') return new Error('gh could not run; install the GitHub CLI and ensure gh is on PATH');
  if (failure === 'timeout') return new Error(`gh did not answer in time while reading ${what}; check the network and retry`);
  return new Error(`Cannot read ${what} from GitHub; ${check}`);
}

/** The real reader: the `gh` CLI, which owns its own credentials. Read-only.
 * `read` is injectable so tests cover the source without a live GitHub. */
export function ghPrSourceWith(read: GhRead): PrSource {
  return {
    async mergedSince(repo, since) {
      if (!TAG.test(since)) throw new Error('Invalid release tag');
      const cwd = process.cwd();
      const slug = repo ?? '{owner}/{repo}';
      const stampRead = await read(cwd, ['api', `repos/${slug}/commits/${since}`, '--jq', '.commit.committer.date']);
      if (stampRead.failure !== null) throw ghReadError('the release tag', stampRead.failure, 'check the repo and tag, and that gh is authenticated');
      const stamp = stampRead.stdout;
      if (stamp === null || Number.isNaN(Date.parse(stamp))) throw new Error('Cannot read the release tag from GitHub; check the repo and tag');
      const rawRead = await read(cwd, ['pr', 'list', ...(repo ? ['--repo', repo] : []), '--state', 'merged', '--search', `merged:>=${stamp.slice(0, 10)}`, '--limit', String(PAGE), '--json', 'number,title,body,mergedAt,files'], PR_LIST_TIMEOUT_MS);
      if (rawRead.failure !== null) throw ghReadError('merged PRs', rawRead.failure, 'check that gh is authenticated and can read the repo');
      let list: unknown;
      try { list = rawRead.stdout === null ? null : JSON.parse(rawRead.stdout); } catch { list = null; }
      if (!Array.isArray(list)) throw new Error('Cannot read merged PRs from GitHub');
      const cut = Date.parse(stamp);
      const prs: MergedPr[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        if (!Number.isSafeInteger(row.number) || typeof row.title !== 'string') continue;
        if (typeof row.mergedAt === 'string' && Date.parse(row.mergedAt) <= cut) continue;
        const files = Array.isArray(row.files) ? row.files.flatMap(file => file && typeof (file as { path?: unknown }).path === 'string' ? [(file as { path: string }).path] : []) : undefined;
        prs.push({ number: Number(row.number), title: row.title, body: typeof row.body === 'string' ? row.body : '', mergedAt: typeof row.mergedAt === 'string' ? row.mergedAt : undefined, files });
      }
      return { prs, complete: list.length < PAGE };
    },
  };
}

export const ghPrSource: PrSource = ghPrSourceWith((cwd, args, timeoutMs) =>
  runGhAttempt(cwd, args, { timeoutMs, signal: backlogScanContext.getStore()?.signal }));
