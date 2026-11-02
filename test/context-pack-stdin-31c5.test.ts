import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import * as reader from '../src/core/util/stable-file-read.js';

const snapshot = () => ({
  node: { jobId: 'current', upstreamJobIds: ['upstream'], query: '雪' },
  tasks: [{ jobId: 'current', text: 'Task 🌍 雪' }],
  outputs: [{ jobId: 'upstream', text: 'Result 🌍 雪' }],
  byteBudget: 4096,
});
let out: string;
let err: string;

beforeEach(() => {
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

function input(text: string): Readable { return Readable.from([Buffer.from(text)]); }

describe('knowledge context-pack stdin', () => {
  it.each([false, true])('matches file input with Unicode split across byte chunks (json=%s)', async json => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-pack-stdin-'));
    try {
      const file = path.join(dir, 'snapshot.json');
      const bytes = Buffer.from(JSON.stringify(snapshot()));
      fs.writeFileSync(file, bytes);
      const flags = json ? ['--json'] : [];
      expect(await runKnowledgeContextPack(['--file', file, ...flags])).toBe(0);
      const expected = out;
      out = '';
      const chunks = Array.from(bytes, byte => Buffer.from([byte]));
      expect(await runKnowledgeContextPack(['--stdin', ...flags], Readable.from(chunks))).toBe(0);
      expect(out).toBe(expected);
      expect(err).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed JSON', '{'],
    ['invalid shape', JSON.stringify({ ...snapshot(), extra: true })],
    ...[0, -1, 1.5, 65537, '10', null].map(budget =>
      [`invalid budget ${String(budget)}`, JSON.stringify({ ...snapshot(), byteBudget: budget })]),
  ])('rejects %s using the snapshot validator', async (_label, text) => {
    expect(await runKnowledgeContextPack(['--stdin'], input(text))).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/valid JSON|invalid shape or byteBudget/);
  });

  it('accepts exactly 1 MiB and rejects a stream over the byte limit, stopping the source', async () => {
    const json = JSON.stringify(snapshot());
    const atLimit = json + ' '.repeat(1024 * 1024 - Buffer.byteLength(json));
    expect(await runKnowledgeContextPack(['--stdin'], input(atLimit))).toBe(0);
    out = '';
    let reads = 0;
    const stream = new Readable({
      read() { reads++; this.push(Buffer.alloc(512 * 1024, 0x20)); },
    });
    expect(await runKnowledgeContextPack(['--stdin'], stream)).toBe(2);
    expect(stream.destroyed).toBe(true);
    expect(reads).toBeLessThanOrEqual(4);
    expect(err).toContain('exceeds 1 MiB');
    expect(out).toBe('');
  });

  it('reports input errors without leaking their contents and destroys the stream', async () => {
    const stream = new Readable({ read() { this.destroy(new Error('private stream detail')); } });
    expect(await runKnowledgeContextPack(['--stdin'], stream)).toBe(1);
    expect(stream.destroyed).toBe(true);
    expect(err).toContain('stdin read error');
    expect(err).not.toContain('private stream detail');
    expect(out).toBe('');
  });

  it('counts UTF-8 bytes rather than characters toward the input limit', async () => {
    const stream = input('雪'.repeat(349526));
    expect(await runKnowledgeContextPack(['--stdin'], stream)).toBe(2);
    expect(err).toContain('exceeds 1 MiB');
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    [], ['--stdin', '--file', 'snapshot.json'], ['--file', 'snapshot.json', '--stdin'],
    ['--stdin', '--stdin'], ['--stdin', '--unknown'], ['--help', '--stdin'],
  ])('rejects incompatible arguments %j without consuming input or reading files', async (...args) => {
    const stream = new Readable({ read() { throw new Error('unexpected read'); } });
    const spy = vi.spyOn(reader, 'readStableRegularFile');
    expect(await runKnowledgeContextPack(args, stream)).toBe(2);
    expect(stream.readableDidRead).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    stream.destroy();
  });

  it.each(['--help', '-h'])('prints %s without reading input', async flag => {
    const stream = new Readable({ read() { throw new Error('unexpected read'); } });
    expect(await runKnowledgeContextPack([flag], stream)).toBe(0);
    expect(out).toContain('--stdin');
    expect(stream.readableDidRead).toBe(false);
    stream.destroy();
  });

  it('preserves the CLI JSON error wrapper for stdin failures', async () => {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input('{') as typeof process.stdin);
    expect(await cmdKnowledge(['context-pack', '--stdin', '--json'])).toBe(2);
    expect(JSON.parse(out)).toEqual({ error: true, exitCode: 2 });
  });
});
