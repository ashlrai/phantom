import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';
import * as reader from '../src/core/util/stable-file-read.js';

let dir: string;
let out: string;
let err: string;
let file: string;
const input = (): NodeContextPackInput => ({
  node: { jobId: 'current', upstreamJobIds: ['upstream'], query: 'needle' },
  tasks: [{ jobId: 'current', text: 'current task' }, { jobId: 'upstream', text: 'upstream task' },
    { jobId: 'unrelated', text: 'nothing relevant' }, { jobId: 'related', text: 'needle match' }],
  outputs: [{ jobId: 'upstream', text: 'upstream result' }, { jobId: 'current', text: 'own output' }],
  byteBudget: 4096,
});

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-pack-')));
  file = path.join(dir, 'snapshot.json');
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function write(value: unknown): void { fs.writeFileSync(file, JSON.stringify(value)); }
async function run(...args: string[]): Promise<number> { return cmdKnowledge(['context-pack', ...args]); }

describe('knowledge context-pack CLI', () => {
  it('routes a snapshot to the builder, preserving citations and priority without an added newline', async () => {
    const data = input(); write(data);
    expect(await run('--file', file)).toBe(0);
    expect(out).toBe(buildNodeContextPack(data));
    expect(out.split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([
      { jobId: 'upstream', kind: 'output', text: 'upstream result', truncated: false },
      { jobId: 'upstream', kind: 'task', text: 'upstream task', truncated: false },
      { jobId: 'current', kind: 'task', text: 'current task', truncated: false },
      { jobId: 'related', kind: 'task', text: 'needle match', truncated: false },
    ]);
    expect(err).toBe('');
  });

  it('reports exact UTF-8 bytes for truncated escaped Unicode in one JSON envelope', async () => {
    const data = input();
    data.outputs = [{ jobId: 'upstream', text: '😀"\\\n'.repeat(100) }];
    data.byteBudget = 100;
    write(data);
    expect(await run('--json', '--file', file)).toBe(0);
    const result = JSON.parse(out) as { v: number; jobId: string; pack: string; bytes: number };
    expect(result).toEqual({ v: 1, jobId: 'current', pack: buildNodeContextPack(data), bytes: Buffer.byteLength(result.pack) });
    expect(result.bytes).toBeLessThanOrEqual(data.byteBudget);
    expect(JSON.parse(result.pack.trim())).toMatchObject({ jobId: 'upstream', kind: 'output', truncated: true });
    expect(out.match(/\n/g)).toHaveLength(1);
  });

  it('supports an empty pack in both formats', async () => {
    const data = input(); data.byteBudget = 1; write(data);
    expect(await run('--file', file)).toBe(0);
    expect(out).toBe('');
    expect(await run('--file', file, '--json')).toBe(0);
    expect(JSON.parse(out)).toEqual({ v: 1, jobId: 'current', pack: '', bytes: 0 });
  });

  it.each([
    [], ['--file'], ['--file', '--json'], ['--file', 'x', '--unknown'],
    ['--file', 'x', '--file', 'y'], ['--json', '--json'], ['--help', '--file', 'x'], ['extra'],
  ])('rejects invalid arguments %j without reading', async (...args) => {
    const spy = vi.spyOn(reader, 'readStableRegularFile');
    expect(await run(...args)).toBe(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('prints help without reading', async () => {
    const spy = vi.spyOn(reader, 'readStableRegularFile');
    expect(await run('--help')).toBe(0);
    expect(out).toContain('context-pack');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { ...input(), extra: 1 }, { ...input(), node: { ...input().node, extra: 1 } },
    { ...input(), node: { jobId: 'x', upstreamJobIds: [1] } },
    { ...input(), node: { jobId: 'x', upstreamJobIds: [], query: null } },
    { ...input(), tasks: [{ jobId: 'x', text: 'y', extra: true }] },
    { ...input(), outputs: [{ jobId: 'x' }] },
    ...[0, -1, 1.5, 65537, Number.MAX_SAFE_INTEGER + 1, '10', null].map(byteBudget => ({ ...input(), byteBudget })),
  ])('rejects invalid snapshot shape or budget %#', async value => {
    write(value);
    expect(await run('--file', file, '--json')).toBe(2);
    expect(JSON.parse(out)).toEqual({ error: true, exitCode: 2 });
  });

  it('accepts the maximum byte budget', async () => {
    write({ ...input(), byteBudget: 65536 });
    expect(await run('--file', file)).toBe(0);
  });

  it('rejects malformed and oversized files', async () => {
    fs.writeFileSync(file, '{');
    expect(await run('--file', file)).toBe(2);
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    expect(await run('--file', file)).toBe(2);
    expect(out).toBe('');
  });

  it('rejects directories and symlinks without following them', async () => {
    write(input());
    const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
    const folder = path.join(dir, 'folder'); fs.mkdirSync(folder);
    expect(await run('--file', folder)).toBe(2);
    expect(await run('--file', link)).toBe(2);
    expect(out).toBe('');
  });

  it('reports missing files and read failures as I/O errors', async () => {
    expect(await run('--file', file, '--json')).toBe(1);
    expect(JSON.parse(out)).toEqual({ error: true, exitCode: 1 });
    out = '';
    vi.spyOn(reader, 'readStableRegularFile').mockReturnValue({ ok: false, reason: 'io-error' });
    expect(await run('--file', file)).toBe(1);
    expect(out).toBe('');
  });
});
