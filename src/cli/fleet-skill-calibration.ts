/**
 * `ashlr fleet skill-calibration` — read-only skill routing calibration
 * snapshot report (RQ-PHX-CALIBRATIONSNAPSHOTCLI31).
 *
 * The M453 projector (core/fleet/skill-routing-calibration-snapshot.ts)
 * verifies the canonical private source document and projects it into an
 * opaque M450 snapshot, but had no non-test consumer — a planner could not
 * tell whether the calibration corpus verifies or how large it is. This
 * command reads the canonical source document and its 32-byte HMAC key,
 * runs the projector and reports only metadata: the verification result,
 * skill and case counts and the policy versions. Raw identifiers, term
 * vectors, key bytes and input paths are never printed.
 *
 * The default locations live under the skill records store
 * ($ASHLR_HOME/skills/routing-calibration/, or ~/.ashlr/skills/...); --source
 * and --key-file override them. READ-ONLY: two bounded file reads, no
 * writes, no network. Exit codes: 0 snapshot verified, 1 withheld,
 * unreadable or absent, 2 bad usage.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { skillRecordsDir } from '../core/fleet/skill-records.js';
import { projectSkillRoutingCalibrationSnapshot } from '../core/fleet/skill-routing-calibration-snapshot.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, red } = makeColors(isTty());

export const FLEET_SKILL_CALIBRATION_USAGE =
  'ashlr fleet skill-calibration [--source FILE] [--key-file FILE] [--json]';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const KEY_BYTES = 32;

/** How a required input read ended; never carries the input path. */
export type SkillCalibrationInputState = 'read' | 'missing' | 'unreadable';

export type SkillCalibrationInputRead =
  | { state: 'read'; bytes: Buffer }
  | { state: 'missing' }
  | { state: 'unreadable' };

/**
 * One bounded read of a required input file. `limit` is the caller's input
 * bound: the reader returns at most limit + 1 bytes so the projector itself
 * rejects oversized input. The production reader is fsReadCalibrationInput.
 */
export type SkillCalibrationFileReader = (path: string, limit: number) => SkillCalibrationInputRead;

export interface FleetSkillCalibrationDeps {
  /** Injected reader; defaults to fsReadCalibrationInput. */
  read?: SkillCalibrationFileReader;
  /** Injected default locations; flags win over these over skillCalibrationPaths(). */
  sourcePath?: string;
  keyPath?: string;
  now?: () => Date;
}

/** Default snapshot inputs under the skill records store. */
export function skillCalibrationPaths(): { sourcePath: string; keyPath: string } {
  const dir = join(skillRecordsDir(), 'routing-calibration');
  return { sourcePath: join(dir, 'source.json'), keyPath: join(dir, 'key.bin') };
}

/**
 * The production reader: a bounded synchronous read that never blocks on a
 * FIFO, requires a regular file and never exposes the path. ENOENT/ENOTDIR
 * report 'missing'; every other failure reports 'unreadable'.
 */
export function fsReadCalibrationInput(path: string, limit: number): SkillCalibrationInputRead {
  let fd: number | undefined;
  const bytes = Buffer.alloc(limit + 1);
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return { state: 'unreadable' };
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    return { state: 'read', bytes: bytes.subarray(0, offset) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface FleetSkillCalibrationReport {
  v: 1;
  generatedAt: string;
  /** verified: projection built; withheld: projector refused; unreadable/absent: inputs. */
  state: 'verified' | 'withheld' | 'unreadable' | 'absent';
  verified: boolean;
  /** The projector reason, or 'input-unreadable' / 'inputs-missing'. */
  reason: string;
  inputs: { source: SkillCalibrationInputState; key: SkillCalibrationInputState };
  skillCount: number | null;
  caseCount: number | null;
  sourceRevision: string | null;
  routerPolicyVersion: string | null;
  projectionPolicyVersion: string | null;
  authority: 'observation-only';
}

function usageError(message: string): number {
  process.stderr.write(`${red('error: ')}${message}\nusage: ${FLEET_SKILL_CALIBRATION_USAGE}\n`);
  return 2;
}

function inputNames(inputs: FleetSkillCalibrationReport['inputs'], state: SkillCalibrationInputState): string {
  return (['source', 'key'] as const).filter((name) => inputs[name] === state).join(', ');
}

export async function cmdFleetSkillCalibration(
  args: string[],
  deps: FleetSkillCalibrationDeps = {},
): Promise<number> {
  let json = false;
  let sourceArg: string | undefined;
  let keyArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`usage: ${FLEET_SKILL_CALIBRATION_USAGE}`);
      return 0;
    }
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    if ((arg === '--source' && sourceArg === undefined) || (arg === '--key-file' && keyArg === undefined)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return usageError(`fleet skill-calibration: ${arg} needs a file path`);
      }
      if (arg === '--source') sourceArg = value; else keyArg = value;
      index += 1;
      continue;
    }
    // Echo flag tokens for typo feedback; a stray positional may be a private
    // path and is never echoed (matching the export example's no-leak posture).
    return usageError(`invalid fleet skill-calibration argument${arg.startsWith('-') ? `: ${arg}` : ''}`);
  }

  const read = deps.read ?? fsReadCalibrationInput;
  const defaults = skillCalibrationPaths();
  const source = read(sourceArg ?? deps.sourcePath ?? defaults.sourcePath, MAX_SOURCE_BYTES);
  const key = read(keyArg ?? deps.keyPath ?? defaults.keyPath, KEY_BYTES);
  const inputs = { source: source.state, key: key.state };
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString();

  const empty = {
    skillCount: null, caseCount: null, sourceRevision: null,
    routerPolicyVersion: null, projectionPolicyVersion: null,
  } as const;
  let report: FleetSkillCalibrationReport;
  try {
    if (source.state === 'unreadable' || key.state === 'unreadable') {
      report = {
        v: 1, generatedAt, state: 'unreadable', verified: false,
        reason: 'input-unreadable', inputs, ...empty, authority: 'observation-only',
      };
    } else if (source.state === 'missing' || key.state === 'missing') {
      report = {
        v: 1, generatedAt, state: 'absent', verified: false,
        reason: 'inputs-missing', inputs, ...empty, authority: 'observation-only',
      };
    } else {
      const projection = projectSkillRoutingCalibrationSnapshot(source.bytes, key.bytes);
      report = projection.state === 'projected'
        ? {
          v: 1, generatedAt, state: 'verified', verified: true, reason: projection.reason, inputs,
          skillCount: projection.snapshot.skills.length,
          caseCount: projection.snapshot.cases.length,
          sourceRevision: projection.snapshot.sourceRevision,
          routerPolicyVersion: projection.snapshot.routerPolicyVersion,
          projectionPolicyVersion: projection.snapshot.projectionPolicyVersion,
          authority: 'observation-only',
        }
        : {
          v: 1, generatedAt, state: 'withheld', verified: false,
          reason: projection.reason, inputs, ...empty, authority: 'observation-only',
        };
    }
  } finally {
    if (source.state === 'read') source.bytes.fill(0);
    if (key.state === 'read') key.bytes.fill(0);
  }

  if (json) {
    console.log(JSON.stringify(report));
  } else if (report.state === 'verified') {
    console.log(bold('Skill routing calibration:') + ' verified');
    console.log(`  skills: ${report.skillCount}  cases: ${report.caseCount}`);
    console.log(`  source revision: ${report.sourceRevision}`);
    console.log(`  policies: router ${report.routerPolicyVersion}  projection ${report.projectionPolicyVersion}`);
  } else {
    const detail = report.state === 'withheld'
      ? report.reason
      : report.state === 'absent'
        ? `missing: ${inputNames(inputs, 'missing')}`
        : `unreadable: ${inputNames(inputs, 'unreadable')}`;
    console.log(bold('Skill routing calibration:') + ` ${red(report.state)} ${dim(`(${detail})`)}`);
  }
  return report.verified ? 0 : 1;
}
