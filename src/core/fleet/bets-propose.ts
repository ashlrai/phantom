/**
 * `phm bets propose --lane <lane> --count <n> [--json]`: the fleet proposes its own next work.
 * It gathers candidates from the checkout's own backlog, runs each through the existing `bets check`
 * (core/fleet/bets-check), drops what already exists, ranks the rest and writes each as a ready-to-queue row.
 * Read-only and offline: nothing here writes a queue file; a person or the leader copies the row they want.
 *
 * Candidate sources:
 *   todo     `// TODO` / `// FIXME` comments under src/ (area = the owner in `TODO(owner)`, else the folder)
 *   roadmap  open `- [ ]` items in docs/ROADMAP*.md
 *   test     skipped or todo tests under test/ (`it.skip`, `describe.todo`, ...)
 *   cli      commands in the help table that no docs page (other than the generated CLI reference) mentions
 *
 * Score (higher first, documented in BETS_PROPOSE_SCORE_RULE):
 *   score = (userFacing ? 1000 : 0) + (200 - size) + (verdict is new ? 5 : 0)
 * so user-facing work comes first, the smallest size next, and brand-new beats partial on a tie.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkGoal, type BetsCheckSources, type BetsCheckVerdict } from './bets-check.js';

export const BETS_PROPOSE_SCHEMA = 'bets.propose.v1';
export const BETS_PROPOSE_SCORE_RULE = 'score = (user-facing 1000) + (200 - size) + (new 5): user-facing work first, smallest size next, new before partial.';
export const MAX_PROPOSE_COUNT = 50;
export const DEFAULT_PROPOSE_COUNT = 5;
/** Per-source cap so one noisy source cannot flood the check step. */
const PER_SOURCE_CAP = 40;

export type ProposeSource = 'todo' | 'roadmap' | 'test' | 'cli';
export interface ProposeCandidate {
  source: ProposeSource;
  /** Plain words naming the work; this is the text the bets check sees. */
  title: string;
  /** Owner area: the `TODO(owner)` owner, a folder, a test file or a command name. */
  area: string;
  path: string;
  line?: number;
}

export interface BetsProposal {
  rank: number;
  /** One token, safe to paste into a queue line. */
  id: string;
  repo: string;
  lane: string;
  source: ProposeSource;
  /** Size estimate in changed lines (the queue's `size<=` field). */
  size: number;
  userFacing: boolean;
  score: number;
  verdict: Exclude<BetsCheckVerdict, 'exists'>;
  goal: string;
  acceptance: string;
  evidence: { path: string; line: number | null; area: string };
  suggestedDelta: string | null;
}

export interface BetsProposeReport {
  schema: typeof BETS_PROPOSE_SCHEMA;
  readOnly: true;
  lane: string;
  repo: string;
  count: number;
  scoreRule: string;
  /** Candidates gathered, and how many the check dropped because the thing already exists. */
  gathered: number;
  droppedExisting: number;
  /** Goals the check dropped because the thing already exists (so a caller can say why). */
  droppedGoals?: string[];
  proposals: BetsProposal[];
}

const SIZE: Record<ProposeSource, number> = { cli: 60, test: 80, todo: 100, roadmap: 200 };
const USER_FACING: Record<ProposeSource, boolean> = { cli: true, roadmap: true, test: false, todo: false };

const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/[`"]/g, "'").trim();
const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** One uppercase token: `RQ-` + up to three main words + a two-digit tag from the title, so near-equal titles stay distinct. */
export function suggestId(title: string): string {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'phm', 'todo', 'fixme', 'with', 'that'].includes(w));
  const slug = words.slice(0, 3).map(w => w.slice(0, 8)).join('').toUpperCase() || 'WORK';
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 100;
  return `RQ-${slug}${String(h).padStart(2, '0')}`;
}

function describe(c: ProposeCandidate): { goal: string; acceptance: string } {
  const where = c.line ? `${c.path}:${c.line}` : c.path;
  switch (c.source) {
    case 'cli': {
      return {
        goal: `The command \`${c.title}\` is in the help table but no docs page explains it. Write a short usage section with one real example in the docs page that fits it best, and link it from docs/cli.md.`,
        acceptance: `Acceptance: \`${c.title}\` appears in a docs/*.md page other than docs/CLI-REFERENCE.md, and \`npm run check:docs\` exits 0.`,
      };
    }
    case 'test':
      return {
        goal: `The test "${c.title}" is skipped or marked todo in ${where}. Make it run: finish what it needs, or delete it if the behavior is gone, and say which in the notes.`,
        acceptance: `Acceptance: "${c.title}" runs without skip or todo in ${c.path} and \`npx vitest run ${c.path}\` passes.`,
      };
    case 'roadmap':
      return {
        goal: `The roadmap item "${c.title}" in ${c.path} is still open. Deliver the smallest working slice a user can run, with a typed JSON output for agents.`,
        acceptance: `Acceptance: the item is ticked in ${c.path} and names the command or test that proves it works.`,
      };
    default:
      return {
        goal: `${where} says "${c.title}" (area ${c.area}). Resolve it with a tested change, or remove the marker with a note when it no longer applies.`,
        acceptance: `Acceptance: the marker at ${where} is gone and a test under test/ covers the behavior it described.`,
      };
  }
}

/**
 * Pure core: check every candidate, drop "exists", rank, cut to `count`.
 */
export function proposeBets(
  candidates: readonly ProposeCandidate[],
  sources: BetsCheckSources,
  opts: { lane: string; repo: string; count: number },
): BetsProposeReport {
  const seen = new Set<string>();
  const kept: Omit<BetsProposal, 'rank'>[] = [];
  let gathered = 0, droppedExisting = 0;
  const droppedGoals: string[] = [];
  for (const c of candidates) {
    const key = `${c.source}|${clean(c.title).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gathered++;
    const title = clip(clean(c.title));
    // A docs gap is judged against docs headings only: the command's own help row would always match it.
    const lookup: BetsCheckSources = c.source === 'cli' ? { cli: [], api: [], pane: [], doc: sources.doc } : sources;
    const check = checkGoal(title, lookup);
    if (check.verdict === 'exists') { droppedExisting++; droppedGoals.push(title); continue; }
    const size = SIZE[c.source];
    const score = (USER_FACING[c.source] ? 1000 : 0) + (200 - size) + (check.verdict === 'new' ? 5 : 0);
    const text = describe({ ...c, title });
    kept.push({
      id: suggestId(title), repo: opts.repo, lane: opts.lane, source: c.source, size, userFacing: USER_FACING[c.source], score,
      verdict: check.verdict,
      goal: check.suggestedDelta && c.source !== 'cli' ? `${text.goal} Already in the checkout: ${check.suggestedDelta}` : text.goal,
      acceptance: text.acceptance,
      evidence: { path: c.path, line: c.line ?? null, area: c.area },
      suggestedDelta: check.suggestedDelta,
    });
  }
  kept.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // Two titles can share an id tag; keep each id unique so a queue never gets two rows with one name.
  const ids = new Set<string>();
  const proposals = kept.slice(0, opts.count).map((p, i) => {
    let id = p.id;
    for (let n = 2; ids.has(id); n++) id = `${p.id}${n}`;
    ids.add(id);
    return { rank: i + 1, ...p, id };
  });
  return { schema: BETS_PROPOSE_SCHEMA, readOnly: true, lane: opts.lane, repo: opts.repo, count: opts.count, scoreRule: BETS_PROPOSE_SCORE_RULE, gathered, droppedExisting, droppedGoals, proposals };
}

/** Structural check of a report against bets.propose.v1. */
export function isBetsProposeReport(v: unknown): v is BetsProposeReport {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.schema === BETS_PROPOSE_SCHEMA && r.readOnly === true && typeof r.lane === 'string' && typeof r.repo === 'string'
    && typeof r.gathered === 'number' && typeof r.droppedExisting === 'number' && Array.isArray(r.proposals)
    && r.proposals.every(p => {
      const x = p as Record<string, unknown>;
      return !!x && typeof x.id === 'string' && /^\S+$/.test(x.id) && typeof x.rank === 'number' && typeof x.size === 'number'
        && typeof x.goal === 'string' && typeof x.acceptance === 'string' && x.acceptance.startsWith('Acceptance:')
        && (x.verdict === 'new' || x.verdict === 'partial');
    });
}

/** Plain-words text: one block per proposal, copyable. */
export function proposeLines(r: BetsProposeReport): string[] {
  if (!r.proposals.length) return [`Nothing new to propose for ${r.lane}: ${r.gathered} candidates found, ${r.droppedExisting} already exist.`];
  const lines = [`${r.proposals.length} proposed for ${r.lane} (${r.gathered} found, ${r.droppedExisting} already exist). Read-only: nothing was queued.`];
  for (const p of r.proposals) {
    lines.push('', `${p.rank}. ${p.id}  repo ${p.repo}  size<=${p.size}  ${p.verdict}${p.userFacing ? '  user-facing' : ''}`);
    lines.push(`   ${p.goal}`, `   ${p.acceptance}`, `   from ${p.evidence.path}${p.evidence.line ? `:${p.evidence.line}` : ''}`);
  }
  return lines;
}

// --- readers for the current checkout (read-only, no network) ---

const listDir = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readText = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

function walkFiles(dir: string, ok: (name: string) => boolean, depth: number, visit: (file: string) => boolean): boolean {
  for (const entry of listDir(dir).sort()) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (isDir(full)) { if (depth > 0 && !walkFiles(full, ok, depth - 1, visit)) return false; continue; }
    if (ok(entry) && !visit(full)) return false;
  }
  return true;
}

/** Repo name from package.json (`@ashlr/phantom` -> `phantom`), or the folder name. */
export function readRepoName(root: string): string {
  try {
    const name = (JSON.parse(readText(join(root, 'package.json'))) as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name.replace(/^@[^/]+\//, '');
  } catch { /* fall through */ }
  return root.split(/[\\/]/).filter(Boolean).pop() ?? 'repo';
}

/** `// TODO(owner): text` or `// FIXME text` comment lines under src/. Strings and test fixtures never match: the marker must open a comment. */
export function readTodos(root: string): ProposeCandidate[] {
  const out: ProposeCandidate[] = [];
  const re = /^\s*(?:\/\/|\/\*+|\*)\s*(?:TODO|FIXME)(?:\(([A-Za-z0-9_.-]+)\))?\s*:?\s*(.{8,})$/;
  walkFiles(join(root, 'src'), n => /\.(ts|tsx|mjs)$/.test(n), 8, file => {
    const lines = readText(file).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]!);
      if (!m) continue;
      const path = relative(root, file);
      const folder = path.split('/').slice(1, 3).join('/');
      out.push({ source: 'todo', title: m[2]!.replace(/\*\/\s*$/, ''), area: m[1] ?? folder, path, line: i + 1 });
    }
    return out.length < PER_SOURCE_CAP;
  });
  return out.slice(0, PER_SOURCE_CAP);
}

/** Open `- [ ] item` lines in docs/ROADMAP*.md. */
export function readRoadmapItems(root: string): ProposeCandidate[] {
  const out: ProposeCandidate[] = [];
  for (const file of listDir(join(root, 'docs')).filter(f => /^ROADMAP.*\.md$/.test(f)).sort()) {
    const lines = readText(join(root, 'docs', file)).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*[-*]\s+\[ \]\s+(.{8,})$/.exec(lines[i]!);
      if (m) out.push({ source: 'roadmap', title: m[1]!, area: 'docs', path: `docs/${file}`, line: i + 1 });
    }
  }
  return out.slice(0, PER_SOURCE_CAP);
}

/** Skipped or todo tests (`it.skip`, `describe.todo`, ...) under test/; conditional `skipIf` is a platform guard, not a gap. */
export function readSkippedTests(root: string): ProposeCandidate[] {
  const out: ProposeCandidate[] = [];
  const re = /\b(?:it|test|describe)\.(?:skip|todo)\(\s*(['"`])(.+?)\1/;
  walkFiles(join(root, 'test'), n => /\.test\.(ts|tsx|mjs)$/.test(n), 3, file => {
    const lines = readText(file).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]!);
      if (m) out.push({ source: 'test', title: m[2]!, area: relative(root, file), path: relative(root, file), line: i + 1 });
    }
    return out.length < PER_SOURCE_CAP;
  });
  return out.slice(0, PER_SOURCE_CAP);
}

/** Help-table commands that no docs/*.md page names (the generated CLI reference and docs/cli.md do not count: they list everything). */
export function readUndocumentedCommands(root: string, entries: readonly { cmd: string }[]): ProposeCandidate[] {
  const corpus = listDir(join(root, 'docs')).filter(f => f.endsWith('.md') && f !== 'CLI-REFERENCE.md' && f !== 'cli.md')
    .map(f => readText(join(root, 'docs', f))).join('\n').toLowerCase();
  const out: ProposeCandidate[] = [], seen = new Set<string>();
  for (const e of entries) {
    const words = e.cmd.split(/\s+/);
    const end = words.findIndex(w => /^[[<-]/.test(w));
    const name = (end < 0 ? words : words.slice(0, end)).join(' ').replace(/\|.*$/, '');
    if (!/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    if (corpus.includes(`phm ${name}`) || corpus.includes(`ashlr ${name}`)) continue;
    out.push({ source: 'cli', title: `phm ${name}`, area: name.split(' ')[0]!, path: 'docs/CLI-REFERENCE.md' });
    if (out.length >= PER_SOURCE_CAP) break;
  }
  return out;
}

/** Every source, in the order they are listed in the header. */
export function gatherCandidates(root: string, entries: readonly { cmd: string }[]): ProposeCandidate[] {
  return [...readRoadmapItems(root), ...readUndocumentedCommands(root, entries), ...readSkippedTests(root), ...readTodos(root)];
}
