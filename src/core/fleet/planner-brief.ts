import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { realSupplyBriefLines, type RealSupplyV1 } from './planner-real-supply.js';
import { readSource, type Source } from './runs-parked-queue.js';

const MAX_BYTES = 8 * 1024 * 1024;
/** Rendered byte budget for the MASON INBOX section; newest complete orders win. */
const INBOX_BUDGET = 256 * 1024;
const INBOX_BUDGET_LABEL = '256 KiB';
/** Public-shape job id; malformed ledger cells must never reach the prompt. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** The only heading shape MASON-INBOX.md producers write; it opens an entry. */
const INBOX_HEADING = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET \(/;
// eslint-disable-next-line no-control-regex -- ledger titles must stay a single printable line.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const INGESTED = 'leader/drop/ingested.tsv';
const MASON_INBOX = 'leader/MASON-INBOX.md';
const UNAVAILABLE = '(unavailable from Phantom; read git log origin/master)';
export type PlannerBriefGit = (program: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8'; shell: false }, callback: (error: Error | null, stdout: string) => void) => unknown;
export interface PlannerBriefOptions {
  runsRoot?: string;
  repoRoot?: string;
  note?: string;
  now?: number;
  git?: PlannerBriefGit;
  /**
   * Injected real-supply read (live Dependabot alerts, red scheduled suites
   * and open issues across the fleet's repos). When absent the brief carries
   * no REAL SUPPLY section; when it throws, the section reads unavailable.
   */
  realSupply?: () => Promise<RealSupplyV1>;
}
const lines = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Build a fresh, scrubbed brief; unavailable sources are recorded instead of throwing. */
export async function buildPlannerBrief(opts: PlannerBriefOptions = {}) {
  const root = opts.runsRoot ?? join(homedir(), '.ashlr-runs');
  const missing: string[] = [];
  const states = new Map<string, Source>();
  const source = async (path: string, max: number, tail = false): Promise<string> => {
    const result = await readSource(join(root, path), max, tail);
    states.set(path, result.state);
    if (result.state !== 'healthy') missing.push(path);
    return result.text;
  };
  // readSource cannot report tail truncation; a file larger than its read
  // bound means the window does not cover the source's earliest bytes.
  const overReadWindow = async (path: string, max: number): Promise<boolean> => {
    try { return (await lstat(join(root, path))).size > max; }
    catch { return false; }
  };
  const [orchestration, claude, status, ingested, inbox, ingestedCut, inboxCut] = await Promise.all([
    source('leader/ORCHESTRATION.md', 256 * 1024),
    source('queue/claude-lane.state', 64 * 1024),
    source('queue/status.json', 1024 * 1024),
    source(INGESTED, MAX_BYTES, true),
    source(MASON_INBOX, MAX_BYTES, true),
    overReadWindow(INGESTED, MAX_BYTES),
    overReadWindow(MASON_INBOX, MAX_BYTES),
  ]);
  const laneLines: string[] = [];
  try {
    const parsed: unknown = JSON.parse(status);
    if (!record(parsed) || !record(parsed.lanes)) throw new Error('invalid lanes');
    for (const [lane, row] of Object.entries(parsed.lanes)) {
      if (!record(row)) throw new Error('invalid lane');
      const count = (key: string): number => typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : 0;
      laneLines.push(`${lane} running ${count('running')} target ${count('target')} queued ${count('queued')} held ${row.held ? 'True' : 'False'}`);
    }
  } catch {
    laneLines.length = 0;
    if (!missing.includes('queue/status.json')) missing.push('queue/status.json');
  }
  // Every distinct valid id in the bounded ledger tail is used so the planner
  // never reissues work; malformed rows are counted and their cells ignored.
  const ledgerState = states.get(INGESTED) ?? 'missing';
  const seen = new Set<string>();
  const ids: string[] = [];
  const titles: string[] = [];
  let malformedRows = 0;
  if (ledgerState === 'healthy') {
    for (const line of lines(ingested)) {
      if (!line.trim()) continue;
      const cells = line.split('\t');
      const id = cells[1] ?? '';
      if (cells.length !== 6 || !JOB_ID.test(id)) { malformedRows++; continue; }
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
      const title = (cells[5] ?? '').replace(CONTROL, '').replace(/^#+\s*/, '');
      if (title) titles.push(title);
    }
  }
  const recentTitles = titles.slice(-60);
  const ledgerUnavailable = `(unavailable: ${INGESTED} ${ledgerState})`;
  const usedIdLines = ledgerState !== 'healthy' ? [ledgerUnavailable] : [
    ...(ingestedCut ? ['(source truncated: ingested.tsv exceeds the 8 MiB read window — earlier IDs are not included)'] : []),
    ...(malformedRows ? [`(${malformedRows} malformed ledger row${malformedRows === 1 ? '' : 's'} ignored)`] : []),
    ids.join(' '),
  ];
  const titleLines = ledgerState !== 'healthy' ? [ledgerUnavailable] : recentTitles;
  // Select whole MASON-INBOX entries by their timestamped headings so an order
  // is never cut mid-body; fill the inbox budget newest-first, then render
  // chronologically. Anything dropped is reported, never shown partially.
  const inboxBody: string[] = [];
  const inboxState = states.get(MASON_INBOX) ?? 'missing';
  if (inboxState !== 'healthy') {
    inboxBody.push(`(unavailable: ${MASON_INBOX} ${inboxState})`);
  } else {
    if (inboxCut) inboxBody.push('(source truncated: MASON-INBOX.md exceeds the 8 MiB read window — earlier entries are not included)');
    const entries: Array<{ heading: string; body: string[] }> = [];
    let fragment = 0;
    for (const line of lines(inbox)) {
      if (INBOX_HEADING.test(line)) entries.push({ heading: line, body: [] });
      else if (entries.length) entries[entries.length - 1]!.body.push(line);
      else if (line.trim()) fragment++;
    }
    if (fragment) inboxBody.push(`(${fragment} line${fragment === 1 ? '' : 's'} without a timestamped heading omitted — partial or foreign content)`);
    const picked: string[] = [];
    let used = 0;
    let omitted = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      let rendered = [entry.heading, ...entry.body].join('\n');
      let bytes = Buffer.byteLength(rendered) + 1;
      if (used + bytes > INBOX_BUDGET) {
        if (bytes <= INBOX_BUDGET) { omitted++; continue; }
        rendered = `${entry.heading}\n(order body omitted: entry is ${bytes} bytes — over the ${INBOX_BUDGET_LABEL} inbox budget)`;
        bytes = Buffer.byteLength(rendered) + 1;
        if (used + bytes > INBOX_BUDGET) { omitted++; continue; }
      }
      used += bytes;
      picked.unshift(rendered);
    }
    if (omitted) inboxBody.push(`(${omitted} older entr${omitted === 1 ? 'y' : 'ies'} omitted — over the ${INBOX_BUDGET_LABEL} inbox budget)`);
    inboxBody.push(...picked);
    if (!picked.length && !fragment && !inboxCut && !omitted) inboxBody.push('(no entries)');
  }
  const inboxLineCount = inboxBody.reduce((total, part) => total + part.split('\n').length, 0);
  let merges: string[] = [];
  let mergeText: string;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      (opts.git ?? execFile)('git', ['-C', opts.repoRoot ?? join(homedir(), 'Projects', 'ashlrai', 'phantom'), 'log', 'origin/master', '--format=%s', '-15'],
        { timeout: 5000, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false },
        (error, output) => error ? reject(error) : resolve(output));
    });
    merges = lines(stdout).filter(subject => subject.startsWith('bridge(')).map(subject => subject.slice(0, 100));
    mergeText = merges.join('\n');
  } catch {
    mergeText = UNAVAILABLE;
    missing.push('git log origin/master');
  }
  let realSupply: string[] | null = null;
  if (opts.realSupply !== undefined) {
    try {
      realSupply = realSupplyBriefLines(await opts.realSupply());
    } catch {
      realSupply = ['(unavailable: real supply read failed)'];
      missing.push('real-supply');
    }
  }
  // eslint-disable-next-line no-control-regex -- tick notes must remain a single printable line.
  const note = opts.note?.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 500);
  const text = scrubSecrets([
    missing.includes('leader/ORCHESTRATION.md') ? '## ORCHESTRATION.md missing' : orchestration,
    ...(opts.note !== undefined ? [`NOTE FROM TICK: ${note}`] : []),
    `## CLAUDE LANE: ${claude.trim() || 'unknown'}`,
    '## LANES', ...laneLines,
    ...(realSupply === null ? [] : ['## REAL SUPPLY', ...realSupply]),
    '## USED IDS', ...usedIdLines,
    '## USED TITLES', ...titleLines,
    '## RECENT PHANTOM MERGES', mergeText,
    '## MASON INBOX (newest last)', ...inboxBody,
    '', 'Now write the job files in your current directory, then stop. Output a one-line summary.',
  ].join('\n'));
  return { v: 1 as const, text, bytes: Buffer.byteLength(text), sections: { usedIds: ids.length, usedTitles: recentTitles.length, lanes: laneLines.length, inboxLines: inboxLineCount, merges: merges.length, ...(realSupply === null ? {} : { realSupply: realSupply.length }) }, missing };
}

/** Publish only a prompt the planner's bounded input reader can consume. */
export function writePlannerBrief(runsRoot: string, text: string): { path: string; bytes: number } {
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) throw new Error('planner brief exceeds 8 MiB');
  ensurePrivateDirectory(join(runsRoot, 'queue'));
  const path = join(runsRoot, 'queue', 'planner-brief.prompt');
  writePrivateFileAtomic(path, text);
  return { path, bytes };
}
