import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  CONTEXT_MEASUREMENT,
  JOB_SHAPE_SOURCE,
  jobShapeHeuristic,
  type JobShape,
} from '../core/fleet/recorded-job-shape.js';

/** Largest prompt file read. Longer input is refused, not truncated, so the shape always describes the whole file. */
export const JOB_SHAPE_MAX_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 4096;

const usage = `Usage: phm fleet job-shape --file <prompt-file> [--json]
Offline advisory job shape (complexity, risk, context, latency) from one local text file.
Reads one regular file of at most ${JOB_SHAPE_MAX_BYTES} bytes. No model call, network or writes.
The result is advisory evidence only: it grants no dispatch, admission, claim or spend authority.`;

type ReadOutcome = { ok: true; text: string; bytes: number } | { ok: false; error: string };

/** Map every filesystem failure to a fixed message; raw errno text and the path are never printed. */
function openError(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === 'ELOOP' || code === 'EMLINK') return 'unsafe input: symbolic links are refused';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'input file not found';
  if (code === 'EACCES' || code === 'EPERM') return 'input file is not readable';
  return 'input file could not be opened';
}

/** Read one bounded regular file. No symlinks, no FIFOs or devices, no NUL bytes, no more than the byte cap. */
async function readPromptFile(path: string): Promise<ReadOutcome> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return { ok: false, error: openError(err) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, error: 'unsafe input: not a regular file' };
    if (info.size > JOB_SHAPE_MAX_BYTES) return { ok: false, error: `input file exceeds ${JOB_SHAPE_MAX_BYTES} bytes` };
    // Read at most cap+1 bytes so a file that grows after stat is still refused.
    const buffer = Buffer.alloc(JOB_SHAPE_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > JOB_SHAPE_MAX_BYTES) return { ok: false, error: `input file exceeds ${JOB_SHAPE_MAX_BYTES} bytes` };
    }
    const bytes = buffer.subarray(0, total);
    if (bytes.includes(0)) return { ok: false, error: 'unsafe input: binary content (NUL byte) is refused' };
    return { ok: true, text: bytes.toString('utf8'), bytes: total };
  } catch {
    return { ok: false, error: 'input file could not be read' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function report(shape: JobShape, bytes: number): Record<string, unknown> {
  return {
    schema: 'fleet.job-shape.v1',
    advisory: true,
    authority: 'none',
    source: JOB_SHAPE_SOURCE,
    input: { bytes, characters: shape.contextTokens, empty: shape.contextTokens === 0 },
    shape,
    context: CONTEXT_MEASUREMENT,
  };
}

/** `phm fleet job-shape --file <path> [--json]`. Exit 0 on advice, 1 on unusable input, 2 on bad arguments. */
export async function cmdFleetJobShape(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[i + 1];
      if (value === undefined || value === '' || value.startsWith('--') || value.includes('\0') || value.length > MAX_PATH_LENGTH) {
        console.error(usage);
        return 2;
      }
      file = value;
      i++;
    } else {
      console.error(usage);
      return 2;
    }
  }
  if (file === undefined) {
    console.error(usage);
    return 2;
  }

  const read = await readPromptFile(file);
  if (!read.ok) {
    if (json) console.log(JSON.stringify({ schema: 'fleet.job-shape.v1', advisory: true, authority: 'none', error: read.error }));
    else console.error(`error: ${read.error}`);
    return 1;
  }
  const shape = jobShapeHeuristic(read.text);
  if (json) {
    console.log(JSON.stringify(report(shape, read.bytes)));
  } else {
    console.log(`fleet job-shape (advisory, no authority): complexity=${shape.complexity} risk=${shape.risk} latency=${shape.latency}`);
    console.log(`context: ${shape.contextTokens} ${CONTEXT_MEASUREMENT.unit} (heuristic, capped at ${CONTEXT_MEASUREMENT.cap}; not provider tokens)`);
    console.log(`source: PR #${JOB_SHAPE_SOURCE.pr} at ${JOB_SHAPE_SOURCE.head.slice(0, 12)} (heuristic only)`);
  }
  return 0;
}
