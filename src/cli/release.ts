import { getReleaseStatus, formatReleaseStatus } from '../core/release/status.js';
import { releaseStatus, readReleaseState, TRAIN_SCHEMA, type TrainState } from '../core/release/train.js';
import { collectReleaseNotes, formatReleaseNotes, writeReleaseNotes } from '../core/release/notes.js';
import { execFileSync } from 'node:child_process';

export const RELEASE_USAGE = 'phm release status [--json | --text] [--file <release-state.json>]\nphm release notes [--since <tag>] [--json] [--write]';

function notesCommand(args: string[]): number {
  const json = args.includes('--json');
  let since: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--since', '--json', '--write'].includes(arg) || seen.has(arg) || (arg === '--since' && (!args[i + 1] || args[i + 1]!.startsWith('-')))) {
      if (json) emit({ ok: false, reason: RELEASE_USAGE }, true);
      else process.stderr.write(`${RELEASE_USAGE}\n`);
      return 2;
    }
    seen.add(arg);
    if (arg === '--since') since = args[++i];
  }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const notes = collectReleaseNotes(root, since);
    if (seen.has('--write')) writeReleaseNotes(root, notes);
    if (json) emit(notes, true);
    else process.stdout.write(formatReleaseNotes(notes));
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Cannot generate release notes';
    if (json) emit({ ok: false, reason }, true);
    else process.stderr.write(`Release notes: ${reason}\n`);
    return 1;
  }
}

function emit(payload: unknown, json: boolean): void {
  process.stdout.write(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
}

export async function cmdRelease(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${RELEASE_USAGE}\n`);
    return 0;
  }
  if (args[0] === 'notes') return notesCommand(args.slice(1));
  const json = !args.includes('--text');
  const rest = args.filter((arg) => arg !== '--json' && arg !== '--text');
  if (rest[0] !== 'status') {
    process.stderr.write(`${RELEASE_USAGE}\n`);
    return 2;
  }
  const fileFlag = rest.indexOf('--file');
  const file = fileFlag >= 0 ? rest[fileFlag + 1] : undefined;
  if ((args.includes('--json') && args.includes('--text')) || (rest.length !== (fileFlag === 1 ? 3 : 1)) || (fileFlag >= 0 && !file)) {
    process.stderr.write(`${RELEASE_USAGE}\n`);
    return 2;
  }
  if (!file) {
    const report = await getReleaseStatus();
    if (json) emit(report, true);
    else process.stdout.write(`${formatReleaseStatus(report)}\n`);
    return 0;
  }
  try {
    const state: TrainState = readReleaseState(file);
    emit(releaseStatus(state), json);
    return 0;
  } catch {
    emit({ schema: TRAIN_SCHEMA, ok: false, reason: 'release-state-invalid' }, json);
    return 1;
  }
}
