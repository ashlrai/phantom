import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { readSource } from './runs-parked-queue.js';

const MAX_BYTES = 8 * 1024 * 1024;
const UNAVAILABLE = '(unavailable from Phantom; read git log origin/master)';
export type PlannerBriefGit = (program: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8'; shell: false }, callback: (error: Error | null, stdout: string) => void) => unknown;
export interface PlannerBriefOptions {
  runsRoot?: string;
  repoRoot?: string;
  note?: string;
  now?: number;
  git?: PlannerBriefGit;
}
const lines = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Build a fresh, scrubbed brief; unavailable sources are recorded instead of throwing. */
export async function buildPlannerBrief(opts: PlannerBriefOptions = {}) {
  const root = opts.runsRoot ?? join(homedir(), '.ashlr-runs');
  const missing: string[] = [];
  const source = async (path: string, max: number, tail = false): Promise<string> => {
    const result = await readSource(join(root, path), max, tail);
    if (result.state !== 'healthy') missing.push(path);
    return result.text;
  };
  const [orchestration, claude, status, ingested, inbox] = await Promise.all([
    source('leader/ORCHESTRATION.md', 256 * 1024),
    source('queue/claude-lane.state', 64 * 1024),
    source('queue/status.json', 1024 * 1024),
    source('leader/drop/ingested.tsv', MAX_BYTES, true),
    source('leader/MASON-INBOX.md', MAX_BYTES, true),
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
  const rows = lines(ingested).map(row => row.split('\t'));
  const ids = rows.slice(-300).map(row => row[1] ?? '');
  const titles = rows.slice(-60).map(row => row[5] ?? '');
  const inboxLines = lines(inbox).slice(-60);
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
  // eslint-disable-next-line no-control-regex -- tick notes must remain a single printable line.
  const note = opts.note?.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 500);
  const text = scrubSecrets([
    missing.includes('leader/ORCHESTRATION.md') ? '## ORCHESTRATION.md missing' : orchestration,
    ...(opts.note !== undefined ? [`NOTE FROM TICK: ${note}`] : []),
    `## CLAUDE LANE: ${claude.trim() || 'unknown'}`,
    '## LANES', ...laneLines,
    '## USED IDS', ids.join(' '),
    '## USED TITLES', ...titles,
    '## RECENT PHANTOM MERGES', mergeText,
    '## MASON INBOX (newest last)', ...inboxLines,
    '', 'Now write the job files in your current directory, then stop. Output a one-line summary.',
  ].join('\n'));
  return { v: 1 as const, text, bytes: Buffer.byteLength(text), sections: { usedIds: ids.length, usedTitles: titles.length, lanes: laneLines.length, inboxLines: inboxLines.length, merges: merges.length }, missing };
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
