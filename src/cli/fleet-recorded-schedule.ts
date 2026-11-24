/**
 * `ashlr fleet recorded-schedule --file <path> [--json]`: replay one explicitly named
 * archived schedule-result input through assembleRecordedSchedule and print the
 * projection. Reads only --file, bounded to 1 MB before any read. Never discovers HOME,
 * reads auth or session files, contacts providers, solvers or GitHub, appends decisions,
 * dispatches, or applies policy. Results are recorded-input-only, not-current-availability,
 * and executionAuthority none.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assembleRecordedSchedule,
  RecordedScheduleResultError,
  type RecordedScheduleInput,
  type RecordedScheduleResult,
  type RecordedScheduleVariableRow,
} from '../core/providers/coding-cli/recorded-schedule-result.js';
import type { RecordedGreedyAssignment } from '../core/providers/coding-cli/recorded-greedy-assignment.js';
import {
  RECORDED_SOLVER_RESULT_PROVENANCE,
  type NormalizedRecordedSolverResult,
} from '../core/providers/coding-cli/recorded-solver-result.js';
import { RecordedDecisionProjectionError } from '../core/providers/coding-cli/recorded-decision-projection.js';
import { SolutionProjectionError } from '../core/providers/coding-cli/solution-projection.js';

const usage = 'Usage: ashlr fleet recorded-schedule --file <path> [--json]';
/** Archived schedule inputs are a few KB. Larger files are refused before reading. */
const MAX_BYTES = 1_000_000;

/** Fixed-format validation failure. `path` names fields and indices only, never input values. */
class RecordedScheduleShapeError extends Error {
  override name = 'RecordedScheduleShapeError';
  readonly path: string;
  constructor(path: string) {
    super(`invalid recorded schedule field ${path}`);
    this.path = path;
  }
}

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const shapeError = (path: string): RecordedScheduleShapeError => new RecordedScheduleShapeError(path);

/** Rejects non-objects and unknown keys. Unknown key names are not echoed. */
function record(value: unknown, path: string, allowed: readonly string[]): Fields {
  if (!isRecord(value)) throw shapeError(path);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw shapeError(`${path} (unsupported field)`);
  return value;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw shapeError(path);
  return value;
}
function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw shapeError(path);
  return value;
}
function nullableName(value: unknown, path: string): string | null {
  return value === null ? null : nonEmpty(value, path);
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw shapeError(path);
  return value;
}

function parseJob(raw: unknown, path: string): RecordedScheduleInput['jobs'][number] {
  const rec = record(raw, path, ['id', 'jobType', 'canary']);
  const canary = rec['canary'];
  if (typeof canary !== 'boolean') throw shapeError(`${path}.canary`);
  return { id: nonEmpty(rec['id'], `${path}.id`), jobType: nonEmpty(rec['jobType'], `${path}.jobType`), canary };
}

function parseVariable(raw: unknown, path: string): RecordedScheduleVariableRow {
  const rec = record(raw, path, ['name', 'jobId', 'poolId', 'consumer', 'coefficient', 'policyId']);
  return {
    name: nonEmpty(rec['name'], `${path}.name`),
    jobId: nonEmpty(rec['jobId'], `${path}.jobId`),
    poolId: nonEmpty(rec['poolId'], `${path}.poolId`),
    consumer: nullableName(rec['consumer'], `${path}.consumer`),
    coefficient: finite(rec['coefficient'], `${path}.coefficient`),
    policyId: nonEmpty(rec['policyId'], `${path}.policyId`),
  };
}

function parseOutcome(raw: unknown, path: string): NormalizedRecordedSolverResult {
  const rec = record(raw, path, ['status', 'objective', 'values', 'provenance', 'feasibilityAsserted', 'grantsMergeAuthority']);
  const status = rec['status'];
  if (status !== 'optimal' && status !== 'infeasible' && status !== 'timeout' && status !== 'failed') {
    throw shapeError(`${path}.status`);
  }
  const objective = rec['objective'];
  if (objective !== null) finite(objective, `${path}.objective`);
  const values = rec['values'];
  if (!isRecord(values)) throw shapeError(`${path}.values`);
  // Object.fromEntries defines own properties, so a key such as "__proto__" stays data.
  const checked = Object.entries(values).map(([name, value]) => [name, finite(value, `${path}.values`)] as const);
  // Normalizer metadata is accepted only in its pinned shape; the assembler never reads it.
  if (rec['provenance'] !== undefined && !isRecord(rec['provenance'])) throw shapeError(`${path}.provenance`);
  if (rec['feasibilityAsserted'] !== undefined && rec['feasibilityAsserted'] !== false) throw shapeError(`${path}.feasibilityAsserted`);
  if (rec['grantsMergeAuthority'] !== undefined && rec['grantsMergeAuthority'] !== false) throw shapeError(`${path}.grantsMergeAuthority`);
  return {
    status,
    objective: typeof objective === 'number' ? objective : null,
    values: Object.fromEntries(checked),
    provenance: { ...RECORDED_SOLVER_RESULT_PROVENANCE },
    feasibilityAsserted: false,
    grantsMergeAuthority: false,
  };
}

function parseFallback(raw: unknown, path: string): RecordedGreedyAssignment {
  const rec = record(raw, path, ['jobId', 'jobIndex', 'poolId', 'consumer', 'coefficient', 'demand', 'quota']);
  const quota = rec['quota'];
  if (quota !== 'known' && quota !== 'unknown') throw shapeError(`${path}.quota`);
  return {
    jobId: nonEmpty(rec['jobId'], `${path}.jobId`),
    jobIndex: finite(rec['jobIndex'], `${path}.jobIndex`),
    poolId: nonEmpty(rec['poolId'], `${path}.poolId`),
    consumer: nullableName(rec['consumer'], `${path}.consumer`),
    coefficient: finite(rec['coefficient'], `${path}.coefficient`),
    demand: finite(rec['demand'], `${path}.demand`),
    quota,
  };
}

/**
 * Validate the whole RecordedScheduleInput shape and build a fresh typed value. Semantic
 * checks (duplicates, offered alternatives, status consistency) stay in the assembler.
 */
export function parseRecordedScheduleInput(raw: unknown): RecordedScheduleInput {
  const rec = record(raw, 'input', ['jobs', 'variables', 'outcome', 'fallbackSelections', 'defaultPolicyId', 'nowMs']);
  const nowMs = rec['nowMs'];
  if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs)) throw shapeError('nowMs');
  const fallbackRaw = rec['fallbackSelections'];
  return {
    jobs: array(rec['jobs'], 'jobs').map((job, i) => parseJob(job, `jobs[${i}]`)),
    variables: array(rec['variables'], 'variables').map((row, i) => parseVariable(row, `variables[${i}]`)),
    outcome: parseOutcome(rec['outcome'], 'outcome'),
    ...(fallbackRaw === undefined
      ? {}
      : { fallbackSelections: array(fallbackRaw, 'fallbackSelections').map((row, i) => parseFallback(row, `fallbackSelections[${i}]`)) }),
    defaultPolicyId: nonEmpty(rec['defaultPolicyId'], 'defaultPolicyId'),
    nowMs,
  };
}

function parseArgs(args: string[]): { file: string; json: boolean } | null {
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) {
      file = args[i + 1];
      i += 1;
    } else return null;
  }
  return file === undefined ? null : { file, json };
}

type BoundedRead = { text: string } | { error: 'unreadable-file' | 'file-too-large' };

/** Reads one regular file. Size is checked with fstat and again while reading, so a growing file stays bounded. */
function readBounded(absolutePath: string): BoundedRead {
  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) return { error: 'unreadable-file' };
    if (info.size > MAX_BYTES) return { error: 'file-too-large' };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_BYTES) return { error: 'file-too-large' };
    }
    return { text: buffer.subarray(0, length).toString('utf8') };
  } catch {
    return { error: 'unreadable-file' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function describe(r: RecordedScheduleResult): string {
  const selected = r.decisions.filter((d) => d.poolId !== null);
  const unassigned = r.decisions.filter((d) => d.poolId === null);
  const meaning = r.fallbackReason !== null
    ? `fallback (${r.fallbackReason}): the solver did not finish, so the recorded greedy selections are shown. This is not an optimal result.`
    : r.status === 'optimal'
      ? 'optimal: the recorded solver reported an optimal solution; selections are as recorded.'
      : 'infeasible: the recorded solver reported no feasible assignment; nothing was selected and no fallback was used.';
  const label = (d: RecordedScheduleResult['decisions'][number]): string =>
    `${d.jobId} (${d.jobType}${d.canary ? ', canary' : ''}; policy ${d.policyId})`;
  return [
    'Recorded schedule result: recorded-input-only, not-current-availability, executionAuthority none.',
    `Status: ${r.status}; solver ${r.solver}${r.fallbackReason !== null ? `; fallback reason ${r.fallbackReason}` : ''}.`,
    meaning,
    `Recorded objective: ${r.objective === null ? 'null (unknown; not recorded for this status)' : String(r.objective)}. Computed assignment total: ${r.assignmentTotal}.`,
    `Selected jobs (${selected.length}):`,
    ...selected.map((d) => `  ${label(d)} -> pool ${d.poolId}, consumer ${d.consumer ?? 'none'}`),
    `Unassigned jobs (${unassigned.length}):`,
    ...unassigned.map((d) => `  ${label(d)}`),
    'Archived evidence only: this grants no execution authority and does not prove current quota, capacity or permission to dispatch.',
  ].join('\n');
}

export async function cmdFleetRecordedSchedule(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nInspect one archived schedule-result input: replays the recorded outcome (optimal, infeasible, timeout or failed with recorded fallback) without dispatching or applying policy. Reads only --file, up to 1 MB. Exit 2 on invalid arguments, 1 when the file is unreadable, too large, or invalid.`);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error(`error: invalid fleet recorded-schedule arguments\n${usage}`);
    return 2;
  }
  const fail = (payload: Record<string, string>, human: string): number => {
    if (parsed.json) console.log(JSON.stringify(payload));
    else console.error(human);
    return 1;
  };

  const read = readBounded(resolve(parsed.file));
  if (!('text' in read)) {
    return read.error === 'file-too-large'
      ? fail({ error: read.error }, `error: recorded schedule file exceeds ${MAX_BYTES} bytes; not read`)
      : fail({ error: read.error }, `error: fleet recorded-schedule could not read ${parsed.file}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    // The parser message can quote input text, so it is never printed.
    return fail({ error: 'malformed-json' }, 'error: recorded schedule file is not valid JSON');
  }

  let input: RecordedScheduleInput;
  try {
    input = parseRecordedScheduleInput(raw);
  } catch (err) {
    if (!(err instanceof RecordedScheduleShapeError)) throw err;
    return fail(
      { error: 'invalid-recorded-schedule', path: err.path },
      `error: invalid recorded schedule field ${err.path}`,
    );
  }

  let result: RecordedScheduleResult;
  try {
    result = assembleRecordedSchedule(input);
  } catch (err) {
    if (!(err instanceof RecordedScheduleResultError || err instanceof RecordedDecisionProjectionError || err instanceof SolutionProjectionError)) {
      throw err;
    }
    // Assembler messages can quote supplied identities, so only a fixed reason is reported.
    return fail(
      { error: 'invalid-recorded-schedule', reason: 'assembler-rejected' },
      'error: recorded schedule evidence was rejected by assembly (inconsistent or unsupported); no input text is shown',
    );
  }

  if (parsed.json) {
    console.log(JSON.stringify({
      basis: 'recorded-input-only',
      availability: 'not-current-availability',
      executionAuthority: 'none',
      result,
    }));
  } else {
    console.log(describe(result));
  }
  return 0;
}
