/** `ashlr fleet lane-model-set` — RQ-PHX-LANEMODELSETVERB01: repoint a lane
 * (or one lane.tier row) at another model id in <runsDir>/models.json, the
 * map the Mac launcher's launch.sh reads for each worker. Prints the key's
 * before/after plus the resolved tier rows the next launch will use; --unset
 * deletes the key, --dry-run previews without writing. */
import { isAbsolute } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { makeColors, isTty } from './ui.js';
import { LaneModelWriteError, setLaneModel, type LaneModelChangeV1 } from '../core/fleet/lane-models-write.js';

const { red } = makeColors(isTty());
const USAGE = 'usage: ashlr fleet lane-model-set <lane[.tier]> <model> [--reason <text>] [--dry-run] [--json] [--runs-dir <abs>] [--models <abs>]\n' +
  '       ashlr fleet lane-model-set <lane[.tier]> --unset [--reason <text>] [--dry-run] [--json] [--runs-dir <abs>] [--models <abs>]';
/** Honesty line: this verb edits the map; it cannot prove the id exists. */
const PROVIDER_WARNING = 'the launcher passes this id to the provider unchanged; a wrong id fails at launch, check the lane\'s next worker log';

/** Pure, no-color render — unit-testable without I/O. */
export function formatLaneModelChange(change: LaneModelChangeV1): string {
  const lines = [`${change.key}: ${change.before ?? '—'} -> ${change.after ?? '—'}`];
  for (const row of change.resolved) {
    lines.push(`  ${row.tier}: ${row.model ?? '—'}${row.via ? ` (via ${row.via})` : ''}`);
  }
  if (change.after !== null) lines.push(PROVIDER_WARNING);
  lines.push(change.applied ? 'models.json written' : 'dry run: nothing written');
  return lines.join('\n');
}

export async function cmdFleetLaneModelSet(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const bad = rejectUnknownOptions(args, { flags: ['--unset', '--dry-run', '--json'], values: ['--reason', '--runs-dir', '--models'] });
  if (bad) {
    process.stderr.write(red('error: ') + `fleet lane-model-set: ${bad.message}\n${USAGE}\n`);
    return 2;
  }
  const positional: string[] = [];
  const seen = new Set<string>();
  const opts: { runsDir?: string; modelsPath?: string } = {};
  let reason: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') { positional.push(...args.slice(i + 1)); break; }
    if (token === '--reason') { reason = args[++i]; continue; }
    if (token === '--runs-dir' || token === '--models') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) {
        process.stderr.write(red('error: ') + `fleet lane-model-set: ${token} requires an absolute path\n`);
        return 2;
      }
      opts[token === '--runs-dir' ? 'runsDir' : 'modelsPath'] = value;
      continue;
    }
    if (token.startsWith('-')) { seen.add(token); continue; }
    positional.push(token);
  }
  const unset = seen.has('--unset');
  const [key] = positional;
  if (!key || (unset ? positional.length !== 1 : positional.length !== 2)) {
    process.stderr.write(red('error: ') + `fleet lane-model-set: ${unset ? '--unset takes only <lane[.tier]>' : 'expected <lane[.tier]> <model>'}\n${USAGE}\n`);
    return 2;
  }
  try {
    const change = await setLaneModel(
      { key, model: unset ? null : positional[1]!, reason, dryRun: seen.has('--dry-run') },
      opts,
    );
    if (seen.has('--json')) {
      if (change.after !== null) process.stderr.write(`${PROVIDER_WARNING}\n`);
      console.log(JSON.stringify(change));
    } else {
      console.log(formatLaneModelChange(change));
    }
    return 0;
  } catch (error) {
    if (error instanceof LaneModelWriteError) {
      process.stderr.write(red('error: ') + `fleet lane-model-set: ${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
