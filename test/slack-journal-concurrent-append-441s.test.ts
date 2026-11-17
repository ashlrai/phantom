import { spawn as spawnProcess } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSlackJournal, recordSlackObservation, slackBridgeDir, slackJournalPath,
  SLACK_JOURNAL_MAX_BYTES, type SlackObservation,
} from '../src/core/agents/slack-journal.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

import * as preferences from '../src/core/verse/preferences.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-441s-'));
  roots.push(dir);
  return dir;
}
const observation = (eventId: string): SlackObservation => ({
  at: '2026-11-15T12:00:00.000Z', decision: 'ingested', bus: 'posted',
  eventId, channelId: 'C0FAKE441S', messageTs: '1763200000.000200', threadTs: '1763200000.000100',
});
const lockPath = (runsDir: string) => `${slackJournalPath(runsDir)}.lock`;
function seed(runsDir: string, text: string): void {
  mkdirSync(slackBridgeDir(runsDir), { recursive: true, mode: 0o700 });
  writeFileSync(slackJournalPath(runsDir), text, { mode: 0o600 });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Only these synthetic child processes patch builtins. The first writer pauses
// AFTER its predecessor read; peers report observing its actual lock. Releasing
// all writers on a timer alone would not deterministically exercise the race.
const CHILD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [runsDir, gate, id] = process.argv.slice(1);
const journal = runsDir + '/slack-bridge/journal.jsonl';
const lock = journal + '.lock';
const opened = new Set();
const open = fs.openSync, read = fs.readSync, stat = fs.lstatSync;
const wait = path => {
  const deadline = performance.now() + 10000;
  while (!fs.existsSync(path)) {
    if (performance.now() > deadline) throw new Error('barrier deadline');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
};
fs.openSync = function(path, ...args) {
  const fd = open(path, ...args);
  if (String(path) === journal) opened.add(fd);
  else opened.delete(fd);
  return fd;
};
let paused = false;
fs.readSync = function(fd, ...args) {
  const count = read(fd, ...args);
  if (id === '0' && opened.has(fd) && !paused) {
    paused = true;
    fs.writeFileSync(gate + '/read', 'ready');
    wait(gate + '/release');
  }
  return count;
};
fs.lstatSync = function(path, ...args) {
  const result = stat(path, ...args);
  if (id !== '0' && String(path) === lock) fs.writeFileSync(gate + '/contended-' + id, 'ready');
  return result;
};
syncBuiltinESMExports();
const { recordSlackObservation } = await import(${JSON.stringify(pathToFileURL(resolve('src/core/agents/slack-journal.ts')).href)});
fs.writeFileSync(gate + '/ready-' + id, 'ready');
wait(gate + '/start-' + id);
const result = recordSlackObservation({
  at: '2026-11-15T12:00:00.000Z', decision: 'ingested', bus: 'posted',
  eventId: 'Ev0FAKE441S-' + id, channelId: 'C0FAKE441S',
  messageTs: '1763200000.000200', threadTs: '1763200000.000100',
}, { runsDir });
console.log(result);
`;
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('child barrier deadline');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 2));
  }
}

describe('Slack journal serialized append (441s)', () => {
  it('preserves every successful distinct child observation across a forced overlapping read', async () => {
    const runsDir = root(), gate = root();
    seed(runsDir, `${JSON.stringify(observation('seed'))}\n`);
    const children = [0, 1, 2].map(id => {
      const child = spawnProcess(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', CHILD, runsDir, gate, String(id)], {
        env: { HOME: gate, USERPROFILE: gate, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveDone, reject) => {
        child.once('error', reject);
        child.once('close', code => resolveDone({ code, stdout, stderr }));
      });
      return { child, done };
    });
    try {
      await until(() => [0, 1, 2].every(id => existsSync(join(gate, `ready-${id}`))));
      writeFileSync(join(gate, 'start-0'), 'go');
      await until(() => existsSync(join(gate, 'read')));
      for (const id of [1, 2]) writeFileSync(join(gate, `start-${id}`), 'go');
      await until(() => [1, 2].every(id => existsSync(join(gate, `contended-${id}`))));
      writeFileSync(join(gate, 'release'), 'go');
      for (const result of await Promise.all(children.map(child => child.done))) {
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe('recorded');
      }
      const journal = readSlackJournal({ runsDir });
      expect(journal.state).toBe('ok');
      expect(journal.entries.map(row => row.eventId).sort()).toEqual(['Ev0FAKE441S-0', 'Ev0FAKE441S-1', 'Ev0FAKE441S-2', 'seed']);
      expect(journal.entries.every(row => row.threadTs === '1763200000.000100')).toBe(true);
      expect(readdirSync(slackBridgeDir(runsDir))).toEqual(['journal.jsonl']);
      expect(statSync(slackJournalPath(runsDir)).mode & 0o777).toBe(0o600);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
      await Promise.allSettled(children.map(child => child.done));
    }
  }, 20_000);

  it('fails bounded on an old but live lock without reclaiming it, then recovers', () => {
    const runsDir = root();
    seed(runsDir, `${JSON.stringify(observation('seed'))}\n`);
    const lock = acquireLocalStoreLock(lockPath(runsDir), 0);
    expect(lock).not.toBeNull();
    try {
      utimesSync(lockPath(runsDir), new Date(0), new Date(0));
      const before = readFileSync(lockPath(runsDir));
      const started = performance.now();
      expect(recordSlackObservation(observation('blocked'), { runsDir })).toBe('failed');
      expect(performance.now() - started).toBeLessThan(5000);
      expect(readFileSync(lockPath(runsDir))).toEqual(before);
      expect(readSlackJournal({ runsDir }).entries.map(row => row.eventId)).toEqual(['seed']);
    } finally {
      expect(releaseLocalStoreLock(lock)).toBe(true);
    }
    expect(recordSlackObservation(observation('recovered'), { runsDir })).toBe('recorded');
    expect(readdirSync(slackBridgeDir(runsDir))).toEqual(['journal.jsonl']);
  });

  it.each(['bad-json', 'incomplete', 'oversized', 'directory', 'symlink'])('preserves %s predecessor evidence and releases its lock on failure', kind => {
    const runsDir = root(), path = slackJournalPath(runsDir);
    const valid = JSON.stringify(observation('seed'));
    seed(runsDir, kind === 'bad-json' ? `{broken\n${valid}\n` : kind === 'oversized' ? 'x'.repeat(SLACK_JOURNAL_MAX_BYTES + 1) : valid);
    if (kind === 'directory' || kind === 'symlink') {
      rmSync(path);
      if (kind === 'directory') mkdirSync(path);
      else {
        const target = join(runsDir, 'evidence');
        writeFileSync(target, valid);
        symlinkSync(target, path);
      }
    }
    const before = kind === 'directory' ? null : readFileSync(path);
    const inode = lstatSync(path).ino;
    expect(recordSlackObservation(observation('refused'), { runsDir })).toBe('failed');
    expect(readSlackJournal({ runsDir, limit: 1 }).state).toBe('degraded');
    expect(lstatSync(path).ino).toBe(inode);
    if (before !== null) expect(readFileSync(path)).toEqual(before);
    expect(existsSync(lockPath(runsDir))).toBe(false);
    rmSync(path, { recursive: true });
    expect(recordSlackObservation(observation('recovered'), { runsDir })).toBe('recorded');
  });

  it('fails without replacing unreadable evidence or a short read', () => {
    const runsDir = root();
    seed(runsDir, `${JSON.stringify(observation('seed'))}\n`);
    const before = readFileSync(slackJournalPath(runsDir));
    const read = vi.spyOn(preferences, 'readPrivateFileCapped');
    for (const result of [null, { text: '{}', bytes: before.length, mtimeMs: 0, truncated: false }]) {
      read.mockReturnValueOnce(result);
      expect(recordSlackObservation(observation('refused'), { runsDir })).toBe('failed');
      expect(readFileSync(slackJournalPath(runsDir))).toEqual(before);
      expect(existsSync(lockPath(runsDir))).toBe(false);
    }
    read.mockReturnValueOnce(null);
    expect(readSlackJournal({ runsDir }).state).toBe('degraded');
  });

  it('releases the lock after an atomic write failure and permits the next writer', () => {
    const runsDir = root();
    seed(runsDir, `${JSON.stringify(observation('seed'))}\n`);
    const before = readFileSync(slackJournalPath(runsDir));
    vi.spyOn(preferences, 'writePrivateFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic IO failure'); });
    expect(recordSlackObservation(observation('refused'), { runsDir })).toBe('failed');
    expect(readFileSync(slackJournalPath(runsDir))).toEqual(before);
    expect(existsSync(lockPath(runsDir))).toBe(false);
    expect(recordSlackObservation(observation('recovered'), { runsDir })).toBe('recorded');
    expect(readSlackJournal({ runsDir }).entries.map(row => row.eventId)).toEqual(['recovered', 'seed']);
  });

  it('retains a whole-row suffix of at most 192 KiB on overflow and keeps reads bounded and read-only', () => {
    const runsDir = root();
    const rows: string[] = [];
    let bytes = 0;
    for (let i = 0; ; i++) {
      const row = `${JSON.stringify({ ...observation(`Ev0FAKE441S-${i}`), reason: '界'.repeat(256) })}\n`;
      if (bytes + Buffer.byteLength(row) > SLACK_JOURNAL_MAX_BYTES) break;
      rows.push(row);
      bytes += Buffer.byteLength(row);
    }
    seed(runsDir, rows.join(''));
    const newest = { ...observation('newest'), reason: '界'.repeat(256), text: 'SYNTHETIC-UNLISTED' };
    expect(recordSlackObservation(newest, { runsDir })).toBe('recorded');
    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    const { bus, ...newestFields } = observation('newest');
    const expected = [...rows, `${JSON.stringify({ ...newestFields, reason: newest.reason, bus })}\n`];
    while (Buffer.byteLength(expected.join('')) > 192 * 1024) expected.shift();
    expect(raw).toBe(expected.join(''));
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(192 * 1024);
    expect(raw.endsWith('\n')).toBe(true);
    const before = statSync(slackJournalPath(runsDir));
    const files = readdirSync(slackBridgeDir(runsDir));
    expect(readSlackJournal({ runsDir, limit: 1 }).entries.map(row => row.eventId)).toEqual(['newest']);
    expect(readSlackJournal({ runsDir, limit: 4096 }).entries.map(row => row.eventId)).toEqual(expected.map(row => (JSON.parse(row) as SlackObservation).eventId).reverse());
    expect(statSync(slackJournalPath(runsDir)).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(slackJournalPath(runsDir), 'utf8')).toBe(raw);
    expect(readdirSync(slackBridgeDir(runsDir))).toEqual(files);
    const absent = join(runsDir, 'absent');
    expect(readSlackJournal({ runsDir: absent }).state).toBe('missing');
    expect(existsSync(absent)).toBe(false);
  });
});
