import { getReleaseStatus, formatReleaseStatus } from '../core/release/status.js';
import { readReleaseLag, releaseLagLine, type ReleaseLagSources } from '../core/release/lag.js';
import { releaseStatus, readReleaseState, TRAIN_SCHEMA, type TrainState } from '../core/release/train.js';

export const RELEASE_USAGE = 'phm release status [--json] [--file <release-state.json>]\nphm release lag [--json]';

function emit(payload: unknown, json: boolean): void {
  process.stdout.write(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
}

export async function cmdRelease(args: string[], lagSources?: ReleaseLagSources): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${RELEASE_USAGE}\n`);
    return 0;
  }
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  if (rest[0] === 'lag') {
    if (rest.length > 1) {
      process.stderr.write(`${RELEASE_USAGE}\n`);
      return 2;
    }
    const lag = await readReleaseLag(lagSources);
    process.stdout.write(json ? `${JSON.stringify(lag)}\n` : `${releaseLagLine(lag)}\n`);
    return 0;
  }
  if (rest[0] !== 'status') {
    process.stderr.write(`${RELEASE_USAGE}\n`);
    return 2;
  }
  const fileFlag = rest.indexOf('--file');
  const file = fileFlag >= 0 ? rest[fileFlag + 1] : undefined;
  if (rest.some((arg, index) => arg.startsWith('-') && arg !== '--file' && index !== fileFlag + 1) || (fileFlag >= 0 && !file)) {
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
