/**
 * src/core/util/process-group-liveness.ts: a group counts as exited only when
 * Linux /proc shows at least one member and every member is a zombie, on two
 * full scans. Anything else (live or unreadable member, no member, another
 * platform) fails closed as present.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { processGroupHasOnlyZombies, type ProcStatReader } from '../src/core/util/process-group-liveness.js';

const PGID = 4200;
const stat = (pid: number, state: string, pgrp: number, comm = 'node') => `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1 0`;

/** A fake /proc; a function entry throws or yields per read, to vary scans. */
function fakeProc(entries: Record<string, string | (() => string)>): ProcStatReader & { reads: number } {
  const proc = {
    reads: 0,
    list: () => Object.keys(entries),
    stat: (entry: string) => {
      proc.reads += 1;
      const value = entries[entry];
      if (value === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return typeof value === 'function' ? value() : value;
    },
  };
  return proc;
}

describe('processGroupHasOnlyZombies', () => {
  it('confirms a zombie-only group, scanning /proc twice', () => {
    const proc = fakeProc({ self: 'ignored', 100: stat(100, 'S', 1), 4200: stat(4200, 'Z', PGID), 4201: stat(4201, 'X', PGID),
      4300: stat(4300, 'R', 4300, 'odd) R 1 4200 name') });
    expect(processGroupHasOnlyZombies(PGID, 'linux', proc)).toBe(true);
    expect(proc.reads).toBe(8);
  });

  it('refuses a group with any live member, including one that appears only on the second scan', () => {
    for (const state of ['R', 'S', 'D', 'T', 't', 'I']) {
      expect(processGroupHasOnlyZombies(PGID, 'linux', fakeProc({ 4200: stat(4200, 'Z', PGID), 4205: stat(4205, state, PGID) })))
        .toBe(false);
    }
    let scans = 0;
    const late = fakeProc({ 4200: stat(4200, 'Z', PGID), 4209: () => (++scans === 1 ? stat(4209, 'Z', 9) : stat(4209, 'S', PGID)) });
    expect(processGroupHasOnlyZombies(PGID, 'linux', late)).toBe(false);
  });

  it('refuses when an entry or the listing is unreadable or malformed', () => {
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(processGroupHasOnlyZombies(PGID, 'linux', fakeProc({ 4200: stat(4200, 'Z', PGID), 4210: eacces }))).toBe(false);
    expect(processGroupHasOnlyZombies(PGID, 'linux', fakeProc({ 4200: stat(4200, 'Z', PGID), 4211: 'garbage' }))).toBe(false);
    expect(processGroupHasOnlyZombies(PGID, 'linux', fakeProc({ 4200: stat(4200, 'Z', PGID), 4212: '4212 (x) ' }))).toBe(false);
    const unlisted: ProcStatReader = { list: () => { throw new Error('no /proc'); }, stat: () => stat(4200, 'Z', PGID) };
    expect(processGroupHasOnlyZombies(PGID, 'linux', unlisted)).toBe(false);
  });

  it('refuses an empty group, but skips members reaped between listing and reading', () => {
    expect(processGroupHasOnlyZombies(PGID, 'linux', fakeProc({ 100: stat(100, 'S', 1) }))).toBe(false);
    expect(processGroupHasOnlyZombies(PGID, 'linux', fakeProc({}))).toBe(false);
    const reaped = () => { throw Object.assign(new Error('reaped'), { code: 'ESRCH' }); };
    expect(processGroupHasOnlyZombies(PGID, 'linux', fakeProc({ 4200: stat(4200, 'Z', PGID), 4220: reaped }))).toBe(true);
  });

  it('refuses on every non-Linux platform and for invalid pgids, without reading /proc', () => {
    for (const platform of ['darwin', 'win32', 'freebsd', 'openbsd', 'aix', 'sunos'] as const) {
      const proc = fakeProc({ 4200: stat(4200, 'Z', PGID) });
      expect(processGroupHasOnlyZombies(PGID, platform, proc)).toBe(false);
      expect(proc.reads).toBe(0);
    }
    for (const pgid of [0, 1, -4200, 1.5, Number.NaN]) {
      expect(processGroupHasOnlyZombies(pgid, 'linux', fakeProc({ 4200: stat(4200, 'Z', PGID) }))).toBe(false);
    }
  });

  it.runIf(process.platform === 'linux')('reads the real /proc: a real zombie-only group and a real live group', async () => {
    // The backgrounded `setsid` execs in place (a job is not a group leader),
    // so `$!` leads its own group, then exits (zombie) or sleeps (live). Its
    // parent execs `sleep`, which never reaps, so the zombie persists.
    const run = (body: string) => spawn('/bin/sh', ['-c', `setsid /bin/sh -c '${body}' & echo $!; exec sleep 5`],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const pidOf = (child: ReturnType<typeof run>) => new Promise<number>((resolvePid, reject) => {
      child.stdout!.once('data', (chunk: Buffer) => resolvePid(Number(String(chunk).trim())));
      child.once('error', reject);
    });
    const state = (pid: number) => { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.charAt(s.lastIndexOf(') ') + 2); };
    const zombieParent = run('exit 0');
    const liveParent = run('sleep 5');
    let liveLeader = 0;
    try {
      const zombieLeader = await pidOf(zombieParent);
      liveLeader = await pidOf(liveParent);
      const deadline = Date.now() + 3_000;
      while (state(zombieLeader) !== 'Z' && Date.now() < deadline) await delay(10);
      expect(state(zombieLeader)).toBe('Z');
      expect(() => process.kill(-zombieLeader, 0)).not.toThrow();
      expect(processGroupHasOnlyZombies(zombieLeader)).toBe(true);
      expect(processGroupHasOnlyZombies(liveLeader)).toBe(false);
    } finally {
      if (liveLeader > 0) try { process.kill(-liveLeader, 'SIGKILL'); } catch { /* already gone */ }
      for (const child of [zombieParent, liveParent]) child.kill('SIGKILL');
    }
  });
});
