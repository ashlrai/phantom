import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gmailArchivePlanLatestPath, readGmailArchivePlanLatest, writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';

let root: string;
const plan = (inbox: string, archiveCount = 1) => ({ inbox, unread: 101, target: 100, archiveCount, topSenders: [] });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gmail-concurrent-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const moduleUrl = pathToFileURL(resolve('src/core/comms/gmail-archive-plan-latest.ts')).href;
const childScript = `
import { readSync } from 'node:fs';
import { writeGmailArchivePlanLatest } from ${JSON.stringify(moduleUrl)};
const [root, inbox, hold] = process.argv.slice(1);
try {
  writeGmailArchivePlanLatest(root, { inbox, unread: 101, target: 100, archiveCount: 1, topSenders: [],
    now: () => { if (hold === 'hold') { process.stdout.write('locked\\n'); readSync(0, Buffer.alloc(1), 0, 1, null); } return new Date('2026-11-10T00:00:00Z'); } });
  process.stdout.write('saved\\n');
} catch { process.stdout.write('failed\\n'); process.exitCode = 1; }
`;
function writer(inbox: string, hold = false): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript, root, inbox, hold ? 'hold' : ''], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: root },
  });
}
function exited(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveExit, reject) => {
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`writer timed out: ${errors}`)); }, 30_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolveExit({ code, output }); });
  });
}
function locked(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveLock, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('writer did not acquire lock')); }, 30_000);
    child.stdout.once('data', () => { clearTimeout(timer); resolveLock(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`writer exited ${code}`)); });
  });
}

describe('archive plan concurrent processes', () => {
  it('refuses a competing writer and preserves all inboxes after retry', async () => {
    writeGmailArchivePlanLatest(root, plan('other', 3));
    const first = writer('inbox-a', true);
    try {
      await locked(first);
      const before = readFileSync(gmailArchivePlanLatestPath(root), 'utf8');
      const second = await exited(writer('inbox-b'));
      expect(second).toEqual({ code: 1, output: 'failed\n' });
      expect(readFileSync(gmailArchivePlanLatestPath(root), 'utf8')).toBe(before);
      const firstExit = exited(first);
      first.stdin.end('x');
      expect(await firstExit).toEqual({ code: 0, output: 'saved\n' });
      expect(await exited(writer('inbox-b'))).toEqual({ code: 0, output: 'saved\n' });
      writeGmailArchivePlanLatest(root, plan('inbox-a', 7));
      expect(readGmailArchivePlanLatest(root)?.plans.map(p => [p.inbox, p.archiveCount])).toEqual([
        ['inbox-a', 7], ['inbox-b', 1], ['other', 3],
      ]);
      expect(readdirSync(dirname(gmailArchivePlanLatestPath(root)))).toEqual(['gmail-archive-plan-latest.json']);
    } finally { first.kill(); }
  }, 120_000);

  it('releases the lock and temporary file when rename fails', () => {
    const path = gmailArchivePlanLatestPath(root);
    mkdirSync(join(path, 'blocker'), { recursive: true, mode: 0o700 });
    expect(() => writeGmailArchivePlanLatest(root, plan('inbox-a'))).toThrow();
    expect(readdirSync(dirname(path))).toEqual(['gmail-archive-plan-latest.json']);
    rmSync(path, { recursive: true });
    expect(() => writeGmailArchivePlanLatest(root, plan('inbox-b'))).not.toThrow();
  });
});
