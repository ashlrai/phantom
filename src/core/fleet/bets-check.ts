/**
 * `phm bets check "<goal>"`: before a planner queues work, what already exists?
 * Splits the goal into its main words and looks them up in four sources of the current checkout: the CLI help
 * table, the verse API routes, the web-ui route folders and docs/*.md headings. Read-only and offline.
 * The help table is read through the same reader as `phm help --search` (searchHelpEntries), passed in by the CLI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const BETS_CHECK_SCHEMA = 'bets.check.v1';
export const MAX_MATCHES = 10;

export type BetsCheckKind = 'cli' | 'api' | 'pane' | 'doc';
export type BetsCheckVerdict = 'new' | 'partial' | 'exists';

export interface BetsCheckMatch { kind: BetsCheckKind; name: string; path: string }
export interface BetsCheckReport {
  schema: typeof BETS_CHECK_SCHEMA;
  goal: string;
  terms: string[];
  verdict: BetsCheckVerdict;
  matches: BetsCheckMatch[];
  /** One plain line; null when the verdict is `new`. */
  suggestedDelta: string | null;
}

/** One searchable thing. `name` weighs more than `text`. */
export interface BetsCheckItem extends BetsCheckMatch { text: string }
export interface BetsCheckSources { cli: BetsCheckItem[]; api: BetsCheckItem[]; pane: BetsCheckItem[]; doc: BetsCheckItem[] }

const STOP = new Set(('a an the and or but with without for to of in on at by from into onto as is are be it its this that these those so ' +
  'add adds added new make makes build builds create creates implement support supports want need needs should please ' +
  'cli pane panel ui api route routes doc docs command commands phm ashlr feature job task also more any all use using via ' +
  'one two can will able').split(/\s+/));
const KIND_WORDS: Record<string, BetsCheckKind> = { cli: 'cli', command: 'cli', commands: 'cli', pane: 'pane', panel: 'pane', ui: 'pane', api: 'api', route: 'api', routes: 'api', doc: 'doc', docs: 'doc' };

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
export const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The goal's main words (stemmed, deduplicated) and which kinds of thing it names. */
export function goalTerms(goal: string): { terms: string[]; kinds: BetsCheckKind[] } {
  const terms: string[] = [], kinds: BetsCheckKind[] = [];
  for (const w of words(goal)) {
    const kind = KIND_WORDS[w];
    if (kind && !kinds.includes(kind)) kinds.push(kind);
    if (STOP.has(w) || w.length < 3) continue;
    const s = stem(w);
    if (!terms.includes(s)) terms.push(s);
  }
  return { terms, kinds };
}

export const hits = (tokens: string[], term: string): boolean => tokens.some(t => t.startsWith(term) || (t.length >= 4 && term.startsWith(t)));
const KIND_ORDER: Record<BetsCheckKind, number> = { cli: 0, api: 1, pane: 2, doc: 3 };

/** Rank every item by how many goal terms it covers (name counts triple) and decide the verdict. Pure. */
export function checkGoal(goal: string, sources: BetsCheckSources): BetsCheckReport {
  const { terms, kinds } = goalTerms(goal);
  const scored = [...sources.cli, ...sources.api, ...sources.pane, ...sources.doc].map(item => {
    const nameTokens = words(item.name).map(stem), textTokens = words(item.text).map(stem);
    const inName = terms.filter(t => hits(nameTokens, t)), inText = terms.filter(t => !inName.includes(t) && hits(textTokens, t));
    return { item, covered: [...inName, ...inText], named: inName.length, score: (inName.length * 3 + inText.length) * (item.kind === 'doc' ? 0.5 : 1) };
  }).filter(s => s.named > 0 || s.score >= 1)
    .sort((a, b) => b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.item.name.localeCompare(b.item.name));
  const top = scored.slice(0, MAX_MATCHES);
  const matches = top.map(({ item: { kind, name, path } }) => ({ kind, name, path }));
  const real = top.filter(s => s.item.kind !== 'doc');
  const best = real[0];
  const union = new Set(top.slice(0, 3).flatMap(s => s.covered));
  const missing = terms.filter(t => !union.has(t));
  const display = (t: string): string => words(goal).find(w => stem(w) === t) ?? t;
  const verdict: BetsCheckVerdict = !top.length ? 'new'
    : best && best.named > 0 && best.covered.length >= 2 && union.size / terms.length >= 0.5 ? 'exists' : 'partial';
  if (verdict === 'new') return { schema: BETS_CHECK_SCHEMA, goal, terms, verdict, matches, suggestedDelta: null };
  const lead = (best ?? top[0]!).item;
  const leadName = lead.kind === 'cli' ? `\`${lead.name}\`` : `${lead.kind} ${lead.name}`;
  const gaps = missing.map(display);
  const noKind = kinds.filter(k => k !== 'doc' && !top.some(s => s.item.kind === k));
  const gapText = [...gaps.map(g => `"${g}"`), ...noKind.map(k => `a ${k} surface`)];
  const suggestedDelta = verdict === 'exists'
    ? (gapText.length ? `exists as ${leadName}; only ${gapText.join(' and ')} is missing, so deliver just that.` : `exists as ${leadName}; nothing in the goal is missing, so do not queue it.`)
    : `closest is ${leadName}; not covered yet: ${gapText.length ? gapText.join(', ') : 'the rest of the goal'}, so build only that.`;
  return { schema: BETS_CHECK_SCHEMA, goal, terms, verdict, matches, suggestedDelta };
}

/** Gate exit codes for `phm bets check --gate`: 0 new (go), 2 partial (build only the gap), 3 exists (stop), 1 error. */
export const GATE_EXIT: Record<BetsCheckVerdict, 0 | 2 | 3> = { new: 0, partial: 2, exists: 3 };

/**
 * The goal inside a queue prompt: the first non-empty line after "verbatim:" is `<id> (<tags>): <task>`; the goal is
 * the task text after the closing parenthesis, up to "Acceptance:". Null when the prompt has no such line.
 */
export function goalFromPrompt(text: string): string | null {
  const after = /verbatim:[ \t]*\r?\n?/i.exec(text);
  if (!after) return null;
  const line = text.slice(after.index + after[0].length).split(/\r?\n/).find(l => l.trim()) ?? '';
  const task = line.replace(/^\s*[^\s(]*\s*\([^)]*\)\s*:?\s*/, '');
  const goal = task.split(/Acceptance:/i)[0]!.trim();
  return goal || null;
}

/** Structural check of a report against bets.check.v1 (used by tests and agents that want to validate before trusting). */
export function isBetsCheckReport(v: unknown): v is BetsCheckReport {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const verdictOk = r.verdict === 'new' || r.verdict === 'partial' || r.verdict === 'exists';
  const matchesOk = Array.isArray(r.matches) && r.matches.length <= MAX_MATCHES && r.matches.every(m => {
    const x = m as Record<string, unknown>;
    return !!x && ['cli', 'api', 'pane', 'doc'].includes(x.kind as string) && typeof x.name === 'string' && typeof x.path === 'string';
  });
  return r.schema === BETS_CHECK_SCHEMA && typeof r.goal === 'string' && Array.isArray(r.terms) && verdictOk && matchesOk
    && (r.verdict === 'new' ? r.suggestedDelta === null : typeof r.suggestedDelta === 'string');
}

/** Help-table rows as items: the name is the command words before its first argument, e.g. `phm pulse merge-latency`. */
export function helpItems(entries: readonly { cmd: string; desc: string }[]): BetsCheckItem[] {
  return entries.map(e => {
    const name = e.cmd.split(/\s+/).filter((w, i, all) => !/^[\[<-]/.test(w) && all.slice(0, i).every(p => !/^[\[<-]/.test(p))).join(' ');
    return { kind: 'cli' as const, name: `phm ${name}`, path: 'docs/CLI-REFERENCE.md', text: e.desc };
  });
}

// --- readers for the current checkout (read-only, no network) ---

function listDir(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

/** `/api/verse/...` literals in every *-api.ts under src/core: the route registry's modules and their paths. */
export function readApiRoutes(root: string): BetsCheckItem[] {
  const out: BetsCheckItem[] = [], seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    for (const entry of listDir(dir)) {
      const full = join(dir, entry);
      if (isDir(full)) { if (depth < 3 && entry !== 'node_modules') walk(full, depth + 1); continue; }
      if (!entry.endsWith('-api.ts')) continue;
      let src = ''; try { src = readFileSync(full, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(/\/api\/(?:verse|reasoning)\/?[a-z0-9\-_/]*/g)) {
        const name = m[0].replace(/\/$/, '');
        if (name.length < 8 || seen.has(`${name}|${full}`)) continue;
        seen.add(`${name}|${full}`);
        out.push({ kind: 'api', name, path: relative(root, full), text: '' });
      }
    }
  };
  walk(join(root, 'src/core'), 0);
  return out;
}

/** Route folders of the web UI, two levels deep (routes/<area>/<pane>). */
export function readPanes(root: string): BetsCheckItem[] {
  const base = join(root, 'src/web-ui/routes'), out: BetsCheckItem[] = [];
  for (const area of listDir(base)) {
    if (!isDir(join(base, area))) continue;
    out.push({ kind: 'pane', name: area, path: relative(root, join(base, area)), text: '' });
    for (const pane of listDir(join(base, area))) {
      const full = join(base, area, pane);
      if (isDir(full)) out.push({ kind: 'pane', name: pane, path: relative(root, full), text: '' });
    }
  }
  return out;
}

/** Headings (#..###) of docs/*.md; the item name is the heading, the file name rides along as text. */
export function readDocHeadings(root: string): BetsCheckItem[] {
  const dir = join(root, 'docs'), out: BetsCheckItem[] = [];
  for (const file of listDir(dir)) {
    if (!file.endsWith('.md') || !existsSync(join(dir, file))) continue;
    let src = ''; try { src = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
    let fence = false;
    for (const line of src.split('\n')) {
      if (line.startsWith('```')) { fence = !fence; continue; }
      const m = !fence && /^#{1,3}\s+(.+?)\s*#*$/.exec(line);
      if (m) out.push({ kind: 'doc', name: m[1]!, path: `docs/${file}`, text: file.replace(/\.md$/, '') });
    }
  }
  return out;
}
