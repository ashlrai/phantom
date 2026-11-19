/**
 * `phm plan dup "<bet text>"`: has this bet already shipped? Plain keyword overlap (no model calls) against
 * existing CLI verbs, recent merged PR titles / commit subjects and docs headings. Reuses the `bets check` term logic.
 */
import { execFileSync } from 'node:child_process';
import { goalTerms, hits, stem, words, type BetsCheckItem } from '../fleet/bets-check.js';

export const PLAN_DUP_SCHEMA = 'plan.dup.v1';
export const DUP_DAYS = 30;
export const MAX_DUP_MATCHES = 8;

export type DupKind = 'verb' | 'pr' | 'commit' | 'doc';
export type DupVerdict = 'new' | 'partly-shipped' | 'shipped';
export interface DupMatch { kind: DupKind; ref: string; title: string; score: number; why: string }
export interface DupReport {
  schema: typeof PLAN_DUP_SCHEMA;
  bet: string;
  repo: string | null;
  verdict: DupVerdict;
  matches: DupMatch[];
  /** Sources that could not be read; the verdict ignores them. Empty when everything was checked. */
  unknown: string[];
}
export interface DupItem { kind: DupKind; ref: string; title: string; text?: string }
export interface DupSources { verbs: DupItem[]; changes: DupItem[]; docs: DupItem[]; unknown?: string[] }

const SHOWN = 2; // a match needs this many bet words
const KIND_ORDER: Record<DupKind, number> = { verb: 0, pr: 1, commit: 2, doc: 3 };

const round = (n: number): number => Math.round(n * 100) / 100;
const list = (xs: string[]): string => xs.map(x => `"${x}"`).join(', ');

/** Score every item by bet-word overlap (words in the title count triple) and decide the verdict. Pure. */
export function checkDup(bet: string, sources: DupSources, repo: string | null = null): DupReport {
  const { terms } = goalTerms(bet);
  const display = (t: string): string => words(bet).find(w => stem(w) === t) ?? t;
  const scored = [...sources.verbs, ...sources.changes, ...sources.docs].flatMap(item => {
    const titleTokens = words(item.title).map(stem), textTokens = words(item.text ?? '').map(stem);
    const inTitle = terms.filter(t => hits(titleTokens, t));
    const inText = terms.filter(t => !inTitle.includes(t) && hits(textTokens, t));
    const covered = inTitle.length + inText.length;
    if (terms.length === 0 || covered < Math.min(SHOWN, terms.length) || (inTitle.length === 0 && covered < 3)) return [];
    const ratio = Math.min(1, (inTitle.length * 3 + inText.length) / (terms.length * 3));
    const score = round(ratio * (item.kind === 'doc' ? 0.5 : 1));
    return [{ item, inTitle, inText, covered, score, strong: covered / terms.length }];
  }).sort((a, b) => b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.item.ref.localeCompare(b.item.ref)).slice(0, MAX_DUP_MATCHES);
  const matches = scored.map(({ item, inTitle, inText }): DupMatch => ({
    kind: item.kind, ref: item.ref, title: item.title, score: scored.find(s => s.item === item)!.score,
    why: `shares ${list([...inTitle, ...inText].map(display))} with the bet${inTitle.length ? ' (in the title)' : ''}`,
  }));
  const top = scored[0];
  const shipped = !!top && ((top.item.kind === 'verb' && top.covered >= 2 && top.strong >= 0.5)
    || (top.item.kind !== 'doc' && top.covered >= 3 && top.strong >= 0.6));
  return { schema: PLAN_DUP_SCHEMA, bet, repo, verdict: shipped ? 'shipped' : matches.length ? 'partly-shipped' : 'new', matches, unknown: sources.unknown ?? [] };
}

/** `bridge(RQ-X): RQ-X: text (#12)` -> `text`: drop the bridge prefix, repeated job ids and a trailing PR number. */
export function cleanSubject(subject: string): { title: string; pr: string | null } {
  const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? null;
  const title = subject.replace(/\(#\d+\)\s*$/, '').replace(/^bridge\([^)]*\):\s*/i, '').replace(/\bRQ-[A-Z0-9-]+:?\s*/g, '').replace(/^BRIDGE_NOTES:?\s*/, '').trim();
  return { title, pr };
}

/** Subjects merged to the default branch in the last `days` days; null when git cannot answer. */
export function readRecentChanges(root: string, days = DUP_DAYS): DupItem[] | null {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 });
  try {
    const branch = ['origin/master', 'master', 'origin/main', 'main', 'HEAD'].find(b => { try { git('rev-parse', '--verify', '--quiet', b); return true; } catch { return false; } });
    if (!branch) return null;
    const rows = git('log', branch, `--since=${days}.days.ago`, '--no-merges', '--format=%h%x09%s').split('\n').filter(Boolean);
    const seen = new Set<string>(), out: DupItem[] = [];
    for (const row of rows) {
      const tab = row.indexOf('\t');
      const { title, pr } = cleanSubject(row.slice(tab + 1));
      if (!title || seen.has(title)) continue;
      seen.add(title);
      out.push({ kind: pr ? 'pr' : 'commit', ref: pr ? `#${pr}` : row.slice(0, tab), title });
    }
    return out;
  } catch { return null; }
}

/** `bets check` items as dup items, so verbs and docs share one reader. */
export const fromBetsItems = (items: BetsCheckItem[], kind: 'verb' | 'doc'): DupItem[] =>
  items.map(i => ({ kind, ref: i.name, title: i.name, text: kind === 'verb' ? i.text : i.path }));

/** The bet text of a READY task: everything before "Acceptance:". */
export const betText = (task: string): string => task.split(/Acceptance:/i)[0]!.trim();
