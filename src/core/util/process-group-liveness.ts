import { readFileSync, readdirSync } from 'node:fs';

/** The two /proc reads the zombie-only group check needs; injectable for tests. */
export interface ProcStatReader {
  /** Entry names under /proc. */
  list(): readonly string[];
  /** Contents of /proc/<entry>/stat. */
  stat(entry: string): string;
}

const LINUX_PROC: ProcStatReader = {
  list: () => readdirSync('/proc'),
  stat: (entry) => readFileSync(`/proc/${entry}/stat`, 'utf8'),
};

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
}

/** One full /proc scan: true iff >= 1 member of `pgid` was seen and every member is Z or X. */
function scanOnlyZombies(pgid: number, proc: ProcStatReader): boolean {
  let entries: readonly string[];
  try { entries = proc.list(); } catch { return false; }
  let members = 0;
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    let stat: string;
    try { stat = proc.stat(entry); } catch (err) {
      // Exited and reaped between list and read: not a member any more.
      const code = errorCode(err);
      if (code === 'ENOENT' || code === 'ESRCH') continue;
      return false;
    }
    // "pid (comm) state ppid pgrp ...": comm may contain ") ", so use the last.
    const close = stat.lastIndexOf(') ');
    if (close < 0) return false;
    const fields = stat.slice(close + 2).split(' ');
    const memberPgid = Number(fields[2]);
    if (!fields[0] || !Number.isSafeInteger(memberPgid)) return false;
    if (memberPgid !== pgid) continue;
    if (fields[0] !== 'Z' && fields[0] !== 'X') return false;
    members += 1;
  }
  return members > 0;
}

/**
 * Linux only. True when /proc lists at least one member of process group
 * `pgid` and every member is a zombie (Z) or dead (X), on two consecutive
 * full scans.
 *
 * Call it only after kill(-pgid, 0) succeeded. That still succeeds for a group
 * whose members have all exited but are unreaped: a descendant reparented to
 * an init that reaps late or never (containers without --init) stays a
 * zombie. A zombie runs no code and holds no descriptors, and while it exists
 * the PGID stays allocated, so the numeric group cannot be recycled.
 *
 * Fail closed: any live member, unreadable or malformed entry, a scan that
 * sees no member at all, or any platform other than Linux answers false
 * (the caller keeps treating the group as present). Two scans close the
 * window where a live member forks a child at a pid the first scan already
 * passed and then exits before being read.
 */
export function processGroupHasOnlyZombies(
  pgid: number,
  platform: NodeJS.Platform = process.platform,
  proc: ProcStatReader = LINUX_PROC,
): boolean {
  if (platform !== 'linux' || !Number.isSafeInteger(pgid) || pgid <= 1) return false;
  return scanOnlyZombies(pgid, proc) && scanOnlyZombies(pgid, proc);
}
