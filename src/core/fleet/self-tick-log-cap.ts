/**
 * self-tick-log-cap.ts — bounds ~/.ashlr/logs/self-tick.jsonl, the file the
 * launchd agent / systemd timer (self-tick-schedule.ts) appends every tick's
 * stdout and stderr to. Each tick prints every step's full JSON report and
 * nothing else trims the file, so left alone it grows without bound — under
 * Mason's Nov 1 18:06 order that the Mac never reaches the force-quit state
 * again, disk and swap are the live risk. Every self-tick run caps the log
 * once before its steps.
 *
 * WHY TRUNCATE IN PLACE, NOT tmp+rename: launchd and systemd hold the log
 * open in append mode for the whole run. Renaming a fresh file over the path
 * leaves those writers on the renamed-away inode, so the rest of the tick's
 * output would be lost. Through one fd opened r+ this reads the kept tail,
 * ftruncates to 0, writes the tail back at offset 0 and fchmod's 0o600;
 * O_APPEND writers then continue at the new end of the same inode.
 */
import {
  closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync,
  openSync, readSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** The log may grow to this before a tick trims it (2 MiB). */
export const SELF_TICK_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** After a cap this much of the newest log survives (512 KiB). */
export const SELF_TICK_LOG_KEEP_BYTES = 512 * 1024;

/** The one log path the scheduler writes into and the cap trims. */
export function selfTickLogPath(home: string): string {
  return join(home, '.ashlr', 'logs', 'self-tick.jsonl');
}

export interface SelfTickLogCapResult {
  state: 'absent' | 'under' | 'capped' | 'skipped';
  bytesBefore?: number;
  bytesAfter?: number;
}

/**
 * Cap the self-tick log in place. A missing file reports 'absent'; a symlink
 * or non-regular path reports 'skipped' and is never followed or touched; a
 * file at or under maxBytes reports 'under'. Over maxBytes the last
 * keepBytes survive, starting after the first newline in that tail so no
 * partial line is kept — when the tail holds no newline it is kept whole
 * rather than losing the newest record. Never throws: any IO error reports
 * 'skipped'.
 */
export function capSelfTickLog(
  path: string,
  opts?: { maxBytes?: number; keepBytes?: number },
): SelfTickLogCapResult {
  const maxBytes = opts?.maxBytes ?? SELF_TICK_LOG_MAX_BYTES;
  const keepBytes = opts?.keepBytes ?? SELF_TICK_LOG_KEEP_BYTES;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'skipped' };
    const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const size = fstatSync(fd).size;
      if (size <= maxBytes) return { state: 'under', bytesBefore: size };
      const tail = Buffer.alloc(Math.min(keepBytes, size));
      const tailStart = size - tail.length;
      let read = 0;
      while (read < tail.length) {
        const n = readSync(fd, tail, read, tail.length - read, tailStart + read);
        if (n < 1) break;
        read += n;
      }
      const filled = tail.subarray(0, read);
      const newline = filled.indexOf(0x0a);
      const kept = newline === -1 ? filled : filled.subarray(newline + 1);
      ftruncateSync(fd, 0);
      let written = 0;
      while (written < kept.length) {
        const n = writeSync(fd, kept, written, kept.length - written, written);
        if (n < 1) throw new Error('self-tick log cap could not write the kept tail');
        written += n;
      }
      fchmodSync(fd, 0o600);
      return { state: 'capped', bytesBefore: size, bytesAfter: kept.length };
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'skipped' };
  }
}
