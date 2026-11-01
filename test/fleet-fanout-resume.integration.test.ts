import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFleetFanoutResume } from '../scripts/fleet-fanout-resume.js';
import { MAX_BUS_BATCH_BYTES, postBusBatch, type BusBatchReceipt } from '../src/core/fleet/bus-batch-post.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const roots: string[] = [];
const message = (id: string) => ({ id: `fake-${id}`, from: 'fake-planner', to: 'fake-worker',
  priority: 'P1', ttl: 60000, body: { task: 'fake work 🌍' } });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fake-resume-')));
  roots.push(root);
  const file = join(root, 'batch.json');
  const options = { root: join(root, 'inbox'), now: () => 100 };
  const save = (input: unknown) => writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  const run = (args = ['--file', file, '--json']) => {
    const lines: string[] = [];
    const code = runFleetFanoutResume(args, { options, write: text => lines.push(text) });
    expect(lines).toHaveLength(1);
    return { code, receipt: JSON.parse(lines[0]!) as BusBatchReceipt };
  };
  const page = () => listBusInboxAfter(0, 100, options);
  return { root, file, options, save, run, page };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('resumes an interrupted batch in order and replays every retained ID as a duplicate', () => {
  const f = fixture(), rows = ['a', 'b', 'c'].map(message);
  f.save(rows);
  let calls = 0;
  const interrupted = postBusBatch(JSON.stringify(rows), { ...f.options, now: () => {
    if (++calls === 2) throw new Error('fake interruption');
    return 100;
  } });
  expect(interrupted).toMatchObject({ status: 'unavailable', accepted: [{ id: 'fake-a', status: 'posted', cursor: 1 }],
    failure: { index: 1, status: 'unavailable' }, unattempted: ['fake-c'] });
  expect(f.run()).toEqual({ code: 0, receipt: { version: 1, status: 'complete', complete: true,
    failure: null, unattempted: [], accepted: [
      { id: 'fake-a', status: 'duplicate', cursor: 1 },
      { id: 'fake-b', status: 'posted', cursor: 2 },
      { id: 'fake-c', status: 'posted', cursor: 3 },
    ] } });
  expect(f.run().receipt.accepted.map(row => row.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  expect(f.page()).toEqual({ status: 'ok', nextCursor: 3, messages: rows.map((envelope, i) =>
    ({ cursor: i + 1, receivedAt: 100, envelope })) });
}, 30000);

it('stops on changed retained content without appending the remaining suffix', () => {
  const f = fixture(), rows = ['a', 'b', 'c'].map(message);
  expect(postBusBatch(JSON.stringify(rows.slice(0, 2)), f.options).complete).toBe(true);
  f.save([rows[0], { ...rows[1], body: { task: 'fake changed' } }, rows[2]]);
  expect(f.run()).toEqual({ code: 2, receipt: { version: 1, status: 'conflict', complete: false,
    accepted: [{ id: 'fake-a', status: 'duplicate', cursor: 1 }], failure: { index: 1, status: 'conflict' },
    unattempted: ['fake-c'] } });
  expect(f.page()).toMatchObject({ status: 'ok', nextCursor: 2, messages: rows.slice(0, 2).map(envelope => ({ envelope })) });
});

it('rejects invalid whole batches, oversize and malformed UTF-8 before writing', () => {
  const f = fixture();
  for (const rows of [[message('a'), { ...message('b'), ttl: 0 }], [message('a'), message('a')], []]) {
    f.save(rows);
    expect(f.run()).toMatchObject({ code: 2, receipt: { status: 'invalid', accepted: [] } });
    expect(existsSync(f.options.root)).toBe(false);
  }
  writeFileSync(f.file, Buffer.alloc(MAX_BUS_BATCH_BYTES + 1, 32));
  expect(f.run()).toMatchObject({ code: 2, receipt: { status: 'invalid' } });
  writeFileSync(f.file, Buffer.from([0x5b, 0xff, 0x5d]));
  expect(f.run()).toMatchObject({ code: 2, receipt: { status: 'invalid' } });
  expect(existsSync(f.options.root)).toBe(false);
  const valid = JSON.stringify([message('a')]);
  writeFileSync(f.file, valid + ' '.repeat(MAX_BUS_BATCH_BYTES - Buffer.byteLength(valid)));
  expect(f.run()).toMatchObject({ code: 0, receipt: { status: 'complete' } });
});

it('refuses links, non-files, missing files and invalid arguments', () => {
  const f = fixture();
  f.save([message('a')]);
  const link = join(f.root, 'link.json');
  symlinkSync(f.file, link);
  for (const file of [link, f.root, join(f.root, 'missing')]) {
    expect(f.run(['--file', file, '--json'])).toMatchObject({ code: 2, receipt: { status: 'unavailable' } });
  }
  const dirLink = join(f.root, 'link-dir');
  symlinkSync(f.root, dirLink);
  expect(f.run(['--file', join(dirLink, 'batch.json'), '--json']).receipt.status).toBe('unavailable');
  for (const args of [[], ['--file', 'relative.json', '--json'], ['--file', f.file],
    ['--file', f.file, '--json', '--receipt', 'fake']]) {
    expect(f.run(args)).toMatchObject({ code: 2, receipt: { status: 'invalid' } });
  }
  expect(existsSync(f.options.root)).toBe(false);
});

it('maps real writer contention and retained capacity to exit 1', () => {
  const f = fixture();
  f.save([message('a'), message('b')]);
  mkdirSync(f.options.root, { mode: 0o700 });
  const directory = join(f.options.root, 'bus-inbox');
  mkdirSync(directory, { mode: 0o700 });
  const lock = acquireLocalStoreLockWithOutcome(join(directory, 'writer.lock'), 0,
    { anchorPath: f.options.root, exactPrivateStorage: true });
  expect(lock.state).toBe('acquired');
  if (lock.state !== 'acquired') throw new Error('fake lock unavailable');
  try { expect(f.run()).toMatchObject({ code: 1, receipt: { status: 'retryable' } }); }
  finally { releaseLocalStoreLock(lock.lock); }
  writeFileSync(join(directory, 'messages.json'), JSON.stringify(Array.from({ length: 1023 }, (_, i) =>
    ({ cursor: i + 1, receivedAt: 100, envelope: message(`seed-${i}`) }))), { mode: 0o600 });
  expect(f.run()).toMatchObject({ code: 1, receipt: { status: 'full', accepted: [{ id: 'fake-a', cursor: 1024 }],
    failure: { index: 1, status: 'full' } } });
}, 30000);

it('runs as a standalone script and prints help describing replay', () => {
  const f = fixture(), home = join(f.root, 'home');
  mkdirSync(home, { mode: 0o700 });
  f.save([message('cli')]);
  const invoke = (args: string[]) => spawnSync(process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/fleet-fanout-resume.ts', ...args],
    { encoding: 'utf8', env: { ...process.env, HOME: home, ASHLR_HOME: join(home, '.ashlr') } });
  const result = invoke(['--file', f.file, '--json']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'complete', accepted: [{ id: 'fake-cli', status: 'posted' }] });
  expect(invoke(['--file', f.file, '--json']).stdout).toContain('"status":"duplicate"');
  const help = invoke(['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('original complete JSON batch');
  expect(help.stdout).toContain('no automatic retries');
}, 30000);
