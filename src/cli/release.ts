import { getReleaseStatus, formatReleaseStatus } from '../core/release/status.js';
import { releaseStatus, readReleaseState, TRAIN_SCHEMA, type TrainState } from '../core/release/train.js';

export const RELEASE_USAGE = 'phm release status [--json | --text] [--file <release-state.json>]';

function emit(payload: unknown, json: boolean): void {
  process.stdout.write(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
}

export async function cmdRelease(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${RELEASE_USAGE}\n`);
    return 0;
  }
  const json = !args.includes('--text');
  const rest = args.filter((arg) => arg !== '--json' && arg !== '--text');
  if (rest[0] !== 'status') {
    process.stderr.write(`${RELEASE_USAGE}\n`);
    return 2;
  }
  const fileFlag = rest.indexOf('--file');
  const file = fileFlag >= 0 ? rest[fileFlag + 1] : undefined;
  if ((args.includes('--json') && args.includes('--text')) || (rest.length !== (fileFlag === 1 ? 3 : 1)) || (fileFlag >= 0 && (!file || file.startsWith('-')))) {
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
