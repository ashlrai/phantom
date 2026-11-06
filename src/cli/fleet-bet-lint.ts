/** Read-only checks for leader BET proposals before queueing. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FleetBetLintReaders {
  readVision: () => Promise<string>;
  readQueue: () => Promise<string>;
}
export interface FleetBetLintProblem { line: number; message: string }
export interface FleetBetLintReport { readOnly: true; problems: FleetBetLintProblem[] }
const usage = 'Usage: ashlr fleet bet-lint [--json]';
const lanes = new Set(['codex-personal', 'devin', 'claude-api', 'codex-local']);

/** Fields: BET repo lane tier SHORT, then task text (maximum 600 characters). */
export function lintFleetBets(vision: string, queue: string): FleetBetLintReport {
  const problems: FleetBetLintProblem[] = [];
  const seen = new Set<string>();
  // A trailing newline terminates the last line rather than adding a tail entry.
  const lines = queue.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  const queued = new Set(lines.slice(-400).join('\n').match(/[A-Za-z0-9_-]+/gu) ?? []);
  for (const [index, line] of vision.split(/\r?\n/u).entries()) {
    if (!line.startsWith('BET ')) continue;
    const add = (message: string): void => { problems.push({ line: index + 1, message }); };
    const fields = line.trimEnd().split(/\s+/u);
    const lane = fields[2] ?? '';
    const short = fields[4] ?? '';
    const text = /^(?:\S+\s+){4}\S+(?:\s+(.*))?$/u.exec(line)?.[1] ?? '';
    if (Array.from(text).length > 600) add('Text after field 5 exceeds 600 characters');
    if (!lanes.has(lane)) add('Lane must be codex-personal, devin, claude-api or codex-local');
    if (!/^[A-Z0-9]{2,24}$/u.test(short)) add('SHORT must contain 2 to 24 uppercase letters or digits');
    if (short && seen.has(short)) add('SHORT is used twice');
    seen.add(short);
    if (short && queued.has(`RQ-${short}Q8`)) add('RQ-SHORTQ8 already exists in the last 400 queue lines');
  }
  return { readOnly: true, problems };
}

export async function cmdFleetBetLint(args: string[], readers?: FleetBetLintReaders): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(`${usage}\nChecks ~/.ashlr-runs/leader/VISION.md against the last 400 lines of queue/router-queue.md.\nHeader: BET repo lane tier SHORT text\nExit 0 clean, 1 problems or unreadable input, 2 invalid arguments.\n`);
    return 0;
  }
  const json = args.includes('--json');
  if (args.length > 1 || (args.length === 1 && !json)) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const root = join(homedir(), '.ashlr-runs');
  const input = readers ?? {
    readVision: () => readFile(join(root, 'leader', 'VISION.md'), 'utf8'),
    readQueue: () => readFile(join(root, 'queue', 'router-queue.md'), 'utf8'),
  };
  try {
    const [vision, queue] = await Promise.all([input.readVision(), input.readQueue()]);
    const report = lintFleetBets(vision, queue);
    process.stdout.write(json ? JSON.stringify(report) + '\n' :
      report.problems.map(p => `line ${p.line}: ${p.message}\n`).join('') || 'BET lint passed\n');
    return report.problems.length ? 1 : 0;
  } catch {
    const error = 'Unable to read VISION.md or router-queue.md';
    process.stdout.write(json ? JSON.stringify({ readOnly: true, error }) + '\n' : `${error}\n`);
    return 1;
  }
}
