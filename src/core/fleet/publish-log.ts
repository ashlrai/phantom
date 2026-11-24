/** Shared reader for `<job>.publish` logs: bounded, symlink-safe, and the one place that decides "pushed, then aborted". */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export const PUBLISH_LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.publish$/;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Lines of one publish log. Throws when the file is missing, not a regular file or over 2 MiB. */
export async function readPublishLogLines(runsDir: string, name: string): Promise<string[]> {
  const file = await open(join(runsDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Not a file');
    const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error('Log too large');
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
  } finally { await file.close(); }
}

export interface PublishAbort {
  /** Index of the "Create a pull request for '<branch>'" line: proof the push landed. */
  pushed: number;
  /** The last result line, e.g. `RESULT ABORT default-fetch` or the older bare `ABORT default-fetch`. */
  line: string;
  /** Abort reason after `ABORT`, e.g. `default-fetch`; empty when none was logged. */
  reason: string;
}

/** The last push confirmation followed by an abort result line, else null. Accepts `RESULT ABORT x` and bare `ABORT x`. */
export function findPublishAbort(lines: string[], branch: string): PublishAbort | null {
  const pushed = lines.reduce((last, line, index) => line.trim().replace(/^remote:\s*/, '').startsWith(`Create a pull request for '${branch}'`) ? index : last, -1);
  const result = lines.reduce((last, line, index) => /^(?:RESULT\s|ABORT\b)/.test(line) ? index : last, -1);
  const match = result > pushed && pushed >= 0 ? /^(?:RESULT )?ABORT(?:\s+(.*?))?\s*$/.exec(lines[result]!) : null;
  return match ? { pushed, line: lines[result]!, reason: match[1] ?? '' } : null;
}
