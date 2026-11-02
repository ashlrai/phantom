/** Atomic publication with fabricated output and an in-memory child process. */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  launch: undefined as undefined | ((args: string[]) => unknown),
  rename: undefined as undefined | ((source: string, destination: string) => void),
}));

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: (_command: string, args: string[]) => hooks.launch!(args) };
});

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    renameSync: (source: string, destination: string) => {
      hooks.rename?.(source, destination);
      return original.renameSync(source, destination);
    },
  };
});

import { runDevinBusAdapter, type DevinBusAdapterDeps, type DevinBusRequest } from '../src/core/fleet/bus-adapters/devin.js';

const previous = 'Previous complete reply 🧭\n';
let root: string;
let work: string;
let mailbox: string;
let request: DevinBusRequest;
let promptPath: string | undefined;
let authorize: ReturnType<typeof vi.fn<DevinBusAdapterDeps['authorize']>>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'devin-publication-')));
  work = join(root, 'work');
  mailbox = join(root, 'mailbox');
  mkdirSync(work, { mode: 0o700 });
  mkdirSync(mailbox, { mode: 0o700 });
  request = { cwd: work, inboxPath: join(mailbox, 'inbox'), outboxPath: join(mailbox, 'outbox'), timeoutMs: 3000 };
  writeFileSync(request.inboxPath, 'Fabricated inbox message', { mode: 0o600 });
  writeFileSync(request.outboxPath, previous, { mode: 0o600 });
  promptPath = undefined;
  authorize = vi.fn(async () => ({ command: ['fake-devin'], check: () => {} }));
});

afterEach(() => {
  hooks.launch = undefined;
  hooks.rename = undefined;
  rmSync(root, { recursive: true, force: true });
});

function childOutput(stdout: Buffer | string, exitCode = 0, stderr: Buffer | string = ''): void {
  hooks.launch = args => {
    const instruction = args.at(-1)!;
    const prefix = 'Read the host prompt file at ';
    const suffix = ' and follow its host instructions.';
    expect(instruction.startsWith(prefix)).toBe(true);
    expect(instruction.endsWith(suffix)).toBe(true);
    promptPath = JSON.parse(instruction.slice(prefix.length, -suffix.length)) as string;
    expect(readFileSync(promptPath, 'utf8')).toContain('Fabricated inbox message');
    if (process.platform !== 'win32') {
      expect(statSync(promptPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(promptPath)).mode & 0o777).toBe(0o700);
    }
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn(),
    });
    setImmediate(() => {
      child.stdout.write(stdout);
      child.stderr.write(stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
}

function expectClean(): void {
  expect(promptPath).toBeDefined();
  expect(existsSync(promptPath!)).toBe(false);
  expect(readdirSync(work).filter(name => name.startsWith('.phantom-devin-bus-'))).toEqual([]);
  expect(readdirSync(mailbox).filter(name => name.startsWith('.devin-reply-'))).toEqual([]);
}

function expectPrevious(): void {
  expect(readFileSync(request.outboxPath, 'utf8')).toBe(previous);
  expect(readFileSync(request.inboxPath, 'utf8')).toBe('Fabricated inbox message');
  expectClean();
}

describe('Devin bus atomic outbox publication', () => {
  it.each([
    ['failed exit after partial stdout', 'partial reply', 7, 'failed'],
    ['empty reply', '  \n', 0, 'empty-reply'],
    ['stdout overflow', Buffer.alloc(4 * 1024 * 1024 + 1, 'x'), 0, 'output-limit'],
  ] as const)('preserves the previous outbox on %s', async (_scenario, stdout, code, expected) => {
    childOutput(stdout, code);
    const rename = vi.fn();
    hooks.rename = rename;
    await expect(runDevinBusAdapter(request, { authorize })).rejects.toMatchObject({ code: expected });
    expect(authorize).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expectPrevious();
  });

  it('preserves the outbox and removes the staged reply when rename fails', async () => {
    childOutput('complete new reply');
    let staged: { source: string; destination: string; reply: string; prior: string } | undefined;
    const rename = vi.fn((source: string, destination: string) => {
      staged = { source, destination, reply: readFileSync(source, 'utf8'), prior: readFileSync(destination, 'utf8') };
      throw new Error('fabricated rename failure');
    });
    hooks.rename = rename;
    await expect(runDevinBusAdapter(request, { authorize })).rejects.toMatchObject({ code: 'outbox', message: 'Devin bus adapter: outbox.' });
    expect(rename).toHaveBeenCalledOnce();
    expect(staged).toEqual({ source: expect.any(String), destination: request.outboxPath, reply: 'complete new reply', prior: previous });
    expect(dirname(staged!.source)).toBe(mailbox);
    expectPrevious();
  });

  it('publishes one complete scrubbed reply and reports its UTF-8 byte length', async () => {
    const fakeSecret = ['ghp', 'FAKE' + 'x'.repeat(40)].join('_');
    const expected = 'Complete café 🧭\n[REDACTED]\n';
    childOutput(`Complete café 🧭\n${fakeSecret}\n`);
    let staged: { source: string; destination: string; reply: string; prior: string; mode: number } | undefined;
    const rename = vi.fn((source: string, destination: string) => {
      staged = { source, destination, reply: readFileSync(source, 'utf8'), prior: readFileSync(destination, 'utf8'), mode: statSync(source).mode & 0o777 };
    });
    hooks.rename = rename;
    const result = await runDevinBusAdapter(request, { authorize });
    expect(rename).toHaveBeenCalledOnce();
    expect(staged).toMatchObject({ source: expect.any(String), destination: request.outboxPath, reply: expected, prior: previous });
    expect(dirname(staged!.source)).toBe(mailbox);
    if (process.platform !== 'win32') expect(staged!.mode).toBe(0o600);
    expect(readFileSync(request.outboxPath, 'utf8')).toBe(expected);
    expect(result).toEqual({ bytes: Buffer.byteLength(expected, 'utf8') });
    expect(result.bytes).toBeGreaterThan(expected.length);
    expect(readFileSync(request.inboxPath, 'utf8')).toBe('Fabricated inbox message');
    expectClean();
  });

  it('rejects inbox and outbox aliases before authorization', async () => {
    const alias = join(root, 'mailbox-alias');
    symlinkSync(mailbox, alias, 'junction');
    await expect(runDevinBusAdapter({ ...request, outboxPath: join(alias, 'inbox') }, { authorize }))
      .rejects.toMatchObject({ code: 'invalid-request' });
    expect(authorize).not.toHaveBeenCalled();
    expect(readFileSync(request.inboxPath, 'utf8')).toBe('Fabricated inbox message');
    expect(readFileSync(request.outboxPath, 'utf8')).toBe(previous);
    expect(readdirSync(work)).toEqual([]);
    expect(readdirSync(mailbox).sort()).toEqual(['inbox', 'outbox']);
  });
});
