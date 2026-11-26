/**
 * Pre-launch duplicate check: is the work a job asks for already on master?
 *
 * Pulls the named things out of the job goal (command names like `phm foo bar`, flags, file paths, panel names)
 * and looks each one up in the CLI command list, docs/CLI-REFERENCE.md, the file tree and the merged pull
 * requests of the last 7 days in the local job records. Read-only and offline; it never launches or edits a job.
 *
 *   likely_done  every command, flag and panel the goal names is already there, and so is every file it names
 *   partial      some of it is there, some is not: build only what is missing
 *   new          nothing the goal names exists yet
 *   unknown      the goal names no command, file or panel, so there is nothing to look up
 *
 * An existing file is weak evidence (a job often edits a file that exists), so files alone never say likely_done
 * when a command or panel is named, and never say it for a goal that adds something new.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { extractJobPaths } from '../fleet/job-precheck.js';
import { goalFromPrompt, readPanes, stem, words } from '../fleet/bets-check.js';
import { defaultRunsDir } from '../fleet/landed-closes-read.js';
import { readLedgerLines } from '../fleet/ledger-lines.js';
import { parseReadyRows, readReadyText } from '../fleet/ready-row-edit.js';
import { scrubSecrets } from '../util/scrub.js';
import { isQueueRecord, pickQueueString } from './schema.js';

export const DUPCHECK_SCHEMA = 'queue.dupcheck.v1';
const DUPCHECK_WINDOW_DAYS = 7;
const CLI_REFERENCE = 'docs/CLI-REFERENCE.md';
const MAX_GOAL = 12_000;
const MAX_MERGED = 5_000;

export type DupcheckVerdict = 'likely_done' | 'partial' | 'new' | 'unknown';
export type DupcheckNounKind = 'command' | 'flag' | 'file' | 'panel';
export interface DupcheckEvidence { type: 'command' | 'docs' | 'file' | 'panel' | 'merged'; ref: string; detail: string }
export interface DupcheckNoun { kind: DupcheckNounKind; text: string; found: boolean; evidence: DupcheckEvidence[] }
export interface DupcheckReport {
  schema: typeof DUPCHECK_SCHEMA;
  verdict: DupcheckVerdict;
  /** One plain sentence saying what was found and what to do. */
  summary: string;
  source: { kind: 'job' | 'file' | 'text'; id: string | null };
  nouns: DupcheckNoun[];
  /** Every piece of evidence, nouns first, then merged work that matches the job id. */
  evidence: DupcheckEvidence[];
  /** What could not be read. Unknown stays unknown: a gap never counts as "not found". */
  gaps: string[];
}

export interface DupcheckCommand { name: string; text: string; ref: string; type: 'command' | 'docs' }
export interface DupcheckMerged { jobId: string | null; pr: number | null; title: string; mergedAt: string }
export interface DupcheckSources {
  commands: DupcheckCommand[];
  panes: string[];
  fileExists: (path: string) => boolean;
  merged: DupcheckMerged[];
  gaps: string[];
}

// --- reading the goal ---

const STOP_AFTER = new Set('in to for and or that with so which the a an is are of on at by as from it its then when if not no also'.split(' '));
const COMMAND_RE = /\b(?:phm|ashlr)((?:[ \t]+[a-z][a-z0-9-]*){1,4})/g;
const FLAG_RE = /(?<![\w-])(--[a-z][a-z0-9-]*)/g;
const PANEL_RE = /\b([A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z][A-Za-z0-9-]*)?)[ \t]+(?:panel|pane)\b/gi;
const PANEL_SKIP = new Set('the a an new this that each every one desktop web mobile main side detail'.split(' '));

/** The part of a prompt that says what to build: the task after "verbatim:", and after "Deliver:" when it has one. */
export function dupcheckGoal(text: string): string {
  let goal = (goalFromPrompt(text) ?? text).slice(0, MAX_GOAL);
  const deliver = /\bDeliver:/.exec(goal);
  if (deliver) goal = goal.slice(deliver.index + deliver[0].length);
  return goal;
}

export function commandNouns(goal: string): string[] {
  const found: string[][] = [];
  for (const m of goal.matchAll(COMMAND_RE)) {
    const tokens: string[] = [];
    for (const t of m[1]!.trim().split(/\s+/)) { if (STOP_AFTER.has(t)) break; tokens.push(t); }
    if (tokens.length) found.push(tokens);
  }
  const keep = found.filter((t, i) => !found.some((o, j) => j !== i && o.length > t.length && t.every((w, k) => o[k] === w)));
  return [...new Set(keep.map(t => t.join(' ')))];
}

export function panelNouns(goal: string): string[] {
  const out: string[] = [];
  for (const m of goal.matchAll(PANEL_RE)) {
    const parts = m[1]!.toLowerCase().split(/\s+/).filter(w => !PANEL_SKIP.has(w));
    if (parts.length) out.push(parts.join(' '));
  }
  return [...new Set(out)];
}

// --- matching ---

/** Tokens of a help-table command name: the words before the first argument, each with its `a|b` alternatives. */
function nameTokens(cmd: string): string[][] {
  const out: string[][] = [];
  for (const w of cmd.trim().split(/\s+/).slice(1)) { if (/^[[<-]/.test(w)) break; out.push(w.split('|')); }
  return out;
}

function matchCommand(noun: string, commands: readonly DupcheckCommand[]): DupcheckCommand | null {
  const want = noun.split(' ');
  let prefix: DupcheckCommand | null = null;
  for (const c of commands) {
    const have = nameTokens(c.name);
    if (have.length < want.length || !want.every((w, i) => have[i]!.includes(w))) continue;
    if (have.length === want.length) return c;
    prefix ??= c;
  }
  return prefix;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function matchPanel(noun: string, panes: readonly string[]): string | null {
  const want = words(noun).map(stem);
  return panes.find(p => normalize(p) === want.join('') || (want.length === 1 && words(p).map(stem).includes(want[0]!))) ?? null;
}

const mergedLabel = (m: DupcheckMerged): string => (m.pr === null ? m.jobId ?? 'a merged job' : `PR #${m.pr}`);
const mergedEvidence = (m: DupcheckMerged, why: string): DupcheckEvidence =>
  ({ type: 'merged', ref: mergedLabel(m), detail: `${why}: "${m.title.slice(0, 120)}" (merged ${m.mergedAt.slice(0, 10)})` });

/** Does a merged title talk about this command? Needs the whole phrase, e.g. "queue dupcheck". */
function mergedForCommand(noun: string, merged: readonly DupcheckMerged[]): DupcheckMerged | null {
  const phrase = new RegExp(`(?<![a-z0-9-])${noun.replace(/[^a-z0-9 -]/g, '').replace(/ /g, '[ -]')}(?![a-z0-9-])`, 'i');
  return merged.find(m => phrase.test(m.title)) ?? null;
}

/** Pure check of one goal against the given sources. */
export function dupcheckGoalText(text: string, sources: DupcheckSources, opts: { jobId?: string | null; kind?: 'job' | 'file' | 'text' } = {}): DupcheckReport {
  const goal = dupcheckGoal(text);
  const jobId = opts.jobId ?? null;
  const nouns: DupcheckNoun[] = [];

  for (const noun of commandNouns(goal)) {
    const hit = matchCommand(noun, sources.commands);
    const merged = hit ? null : mergedForCommand(noun, sources.merged);
    const evidence: DupcheckEvidence[] = [];
    if (hit) evidence.push({ type: hit.type, ref: hit.ref, detail: `${hit.name.trim()} is listed` });
    else if (merged) evidence.push(mergedEvidence(merged, `merged in the last ${DUPCHECK_WINDOW_DAYS} days`));
    nouns.push({ kind: 'command', text: `phm ${noun}`, found: evidence.length > 0, evidence });
    // A flag only means something next to a command that exists: check it against that command's own line.
    if (hit) {
      const lines = sources.commands.filter(c => c.name === hit.name || c.name.startsWith(`${hit.name} `)).map(c => `${c.name} ${c.text}`).join(' ');
      for (const flag of new Set([...goal.matchAll(FLAG_RE)].map(m => m[1]!))) {
        if (new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(lines)) nouns.push({ kind: 'flag', text: flag, found: true, evidence: [{ type: hit.type, ref: hit.ref, detail: `${flag} is listed for ${hit.name.trim()}` }] });
        else nouns.push({ kind: 'flag', text: flag, found: false, evidence: [] });
      }
    }
  }
  for (const noun of panelNouns(goal)) {
    const pane = matchPanel(noun, sources.panes);
    nouns.push({ kind: 'panel', text: `${noun} panel`, found: pane !== null, evidence: pane ? [{ type: 'panel', ref: `src/web-ui/routes/${pane}`, detail: `a ${pane} route exists` }] : [] });
  }
  for (const path of extractJobPaths(goal)) {
    const there = sources.fileExists(path);
    nouns.push({ kind: 'file', text: path, found: there, evidence: there ? [{ type: 'file', ref: path, detail: 'file is on master' }] : [] });
  }

  const sameJob = jobId ? sources.merged.find(m => m.jobId === jobId) : undefined;
  const evidence = [...nouns.flatMap(n => n.evidence), ...(sameJob ? [mergedEvidence(sameJob, 'this job id already merged')] : [])];
  const source = { kind: opts.kind ?? 'text', id: jobId };
  const base: Omit<DupcheckReport, 'verdict' | 'summary'> = { schema: DUPCHECK_SCHEMA, source, nouns, evidence, gaps: [...sources.gaps] };

  const named = (n: DupcheckNoun): string => n.text;
  const strong = nouns.filter(n => n.kind !== 'file'), files = nouns.filter(n => n.kind === 'file');
  const missing = nouns.filter(n => !n.found), have = nouns.filter(n => n.found);
  if (sameJob) {
    return { ...base, verdict: 'likely_done', summary: `Already done: this job id merged as ${mergedLabel(sameJob)} in the last ${DUPCHECK_WINDOW_DAYS} days. Do not launch it again.` };
  }
  if (!nouns.length) {
    return { ...base, verdict: 'unknown', summary: 'Unknown: the goal names no command, file or panel, so there is nothing to look up. Read the goal and check by hand.' };
  }
  if (strong.length) {
    if (!strong.some(n => n.found)) return { ...base, verdict: 'new', summary: `New: none of ${strong.map(named).join(', ')} exists yet. Launch it.` };
    if (!missing.length) return { ...base, verdict: 'likely_done', summary: `Likely done: ${have.map(named).join(', ')} already exist${have.length === 1 ? 's' : ''}. Check the evidence before launching.` };
    return { ...base, verdict: 'partial', summary: `Partly there: ${have.map(named).join(', ')} exist; ${missing.map(named).join(', ')} not found. Build only the missing part.` };
  }
  // Files only: an existing file never proves the work is done.
  if (!files.some(n => n.found)) return { ...base, verdict: 'new', summary: `New: ${files.map(named).join(', ')} not on master yet. Launch it.` };
  return { ...base, verdict: 'partial', summary: missing.length
    ? `Partly there: ${have.map(named).join(', ')} exist; ${missing.map(named).join(', ')} not found. A file that exists does not mean the work is done.`
    : `Files exist (${have.map(named).join(', ')}) but a file alone does not show the work is done. Check by hand.` };
}

// --- reading the checkout and the job records ---

/** Rows of docs/CLI-REFERENCE.md: the first cell is `<code>phm ...</code>`, the second the description. */
export function referenceCommands(markdown: string): DupcheckCommand[] {
  const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#124;/g, '|').replace(/&amp;/g, '&');
  const out: DupcheckCommand[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*<code>((?:phm|ashlr)\s[^|]*?)<\/code>\s*\|\s*(.*?)\s*\|/.exec(line.replace(/&#124;/g, '\u0001'));
    if (m) out.push({ name: decode(m[1]!).replaceAll('\u0001', '|'), text: decode(m[2]!).replaceAll('\u0001', '|'), ref: CLI_REFERENCE, type: 'docs' });
  }
  return out;
}

const MERGED_LINE = /merge/i;
/** Merged job records inside the window: ledger rows that say merged, with a PR number or title. */
export async function readMergedJobs(runsDir: string, now: number, days = DUPCHECK_WINDOW_DAYS): Promise<DupcheckMerged[] | null> {
  const since = now - days * 86_400_000, rows = new Map<string, DupcheckMerged>();
  const ok = await readLedgerLines(join(runsDir, 'metrics', 'jobs.jsonl'), line => {
    if (rows.size >= MAX_MERGED || !MERGED_LINE.test(line)) return;
    try {
      const r = JSON.parse(line) as unknown;
      if (!isQueueRecord(r)) return;
      // jobs.jsonl field dialects: phases outcome|state|status plus producer
      // aliases, merge stamps merged_at|mergedAt, and the usual id/timestamp
      // spellings dispatchd `_vc_pick` and metrics-outcomes accept.
      const phase = pickQueueString(r, ['outcome', 'state', 'phase', 'status', 'result', 'conclusion']);
      const mergedStamp = pickQueueString(r, ['merged_at', 'mergedAt']);
      if ((phase === null || phase.toUpperCase() !== 'MERGED') && mergedStamp === null) return;
      const at = mergedStamp ?? pickQueueString(r, ['at', 'ts', 'time', 'timestamp', 'closedAt', 'recordedAt', 'updatedAt']);
      const ms = at ? Date.parse(at) : NaN;
      if (!Number.isFinite(ms) || ms < since || ms > now + 86_400_000) return;
      const jobId = pickQueueString(r, ['job_id', 'job', 'jobId', 'id']), pr = typeof r.pr === 'number' ? r.pr : null;
      const title = scrubSecrets(pickQueueString(r, ['pr_title', 'title', 'subject']) ?? '').slice(0, 300);
      if (!title && !jobId) return;
      rows.set(`${jobId ?? ''}#${pr ?? title}`, { jobId, pr, title: title || (jobId ?? ''), mergedAt: new Date(ms).toISOString() });
    } catch { /* a bad line cannot show that anything merged */ }
  });
  return ok ? [...rows.values()] : null;
}

export interface DupcheckLoadDeps {
  root?: string;
  runsDir?: string;
  now?: number;
  /** The CLI command list (HELP_ENTRIES). Loaded from the CLI when not given. */
  help?: readonly { cmd: string; desc: string }[];
}

async function loadDupcheckSources(deps: DupcheckLoadDeps = {}): Promise<DupcheckSources> {
  const root = deps.root ?? process.cwd(), gaps: string[] = [];
  let help = deps.help;
  if (!help) { try { help = (await import('../../cli/help.js')).HELP_ENTRIES; } catch { gaps.push('The CLI command list could not be loaded.'); } }
  const commands: DupcheckCommand[] = (help ?? []).map(e => ({ name: `phm ${e.cmd}`, text: e.desc, ref: 'src/cli/help.ts', type: 'command' as const }));
  try { commands.push(...referenceCommands(readFileSync(join(root, CLI_REFERENCE), 'utf8'))); } catch { gaps.push(`${CLI_REFERENCE} could not be read.`); }
  const merged = await readMergedJobs(deps.runsDir ?? defaultRunsDir(), deps.now ?? Date.now());
  if (merged === null) gaps.push('Merged job records (metrics/jobs.jsonl) could not be read, so recent merges are unknown.');
  const panes = readPanes(root).map(p => basename(p.name));
  if (!panes.length) gaps.push('No web-ui panel folders were found.');
  return { commands, panes, fileExists: p => existsSync(join(root, p)), merged: merged ?? [], gaps };
}

export class DupcheckInputError extends Error {}

/** `<job-id|prompt-file>` -> the prompt text. A file wins; otherwise the id is looked up in queue/ready.tsv. */
async function readDupcheckInput(input: string, deps: { cwd?: string; runsDir?: string } = {}): Promise<{ text: string; jobId: string | null; kind: 'job' | 'file' }> {
  const path = resolve(deps.cwd ?? process.cwd(), input);
  const idLike = /^RQ-[A-Za-z0-9._-]+$/.test(input);
  if (!idLike || existsSync(path)) {
    try { return { text: readFileSync(path, 'utf8'), jobId: idLike ? input : (/^(RQ-[A-Za-z0-9._-]+)\.md$/.exec(basename(path))?.[1] ?? null), kind: 'file' }; }
    catch { throw new DupcheckInputError(`Cannot read ${input}. Give a job id from the queue or a prompt file.`); }
  }
  const runsDir = deps.runsDir ?? defaultRunsDir();
  let rows: ReturnType<typeof parseReadyRows>;
  try { rows = parseReadyRows(await readReadyText(join(runsDir, 'queue', 'ready.tsv'))); }
  catch { throw new DupcheckInputError('The queue file could not be read, so the job id cannot be looked up. Pass the prompt file instead.'); }
  const row = rows.find(r => r.id === input);
  if (!row) throw new DupcheckInputError(`${input} is not in the queue. Pass its prompt file instead.`);
  try { return { text: readFileSync(row.promptPath, 'utf8'), jobId: input, kind: 'job' }; }
  catch { throw new DupcheckInputError(`The prompt file for ${input} could not be read.`); }
}

/** The call for the dispatcher and agents: one job id or prompt file in, one typed report out. Throws DupcheckInputError. */
export async function dupcheckJob(input: string, deps: DupcheckLoadDeps & { cwd?: string } = {}): Promise<DupcheckReport> {
  const read = await readDupcheckInput(input, { cwd: deps.cwd, runsDir: deps.runsDir });
  return dupcheckGoalText(read.text, await loadDupcheckSources(deps), { jobId: read.jobId, kind: read.kind });
}

export function dupcheckLines(report: DupcheckReport): string[] {
  const lines = [report.verdict, report.summary];
  for (const n of report.nouns) lines.push(`  ${n.found ? 'found  ' : 'missing'} ${n.text}${n.evidence[0] ? `  (${n.evidence[0].ref})` : ''}`);
  for (const e of report.evidence.filter(e => e.type === 'merged')) lines.push(`  merged  ${e.ref}: ${e.detail}`);
  for (const g of report.gaps) lines.push(`  unknown: ${g}`);
  return lines;
}
