import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';

const fixture = () => ({
  node: { jobId: 'fake/current', upstreamJobIds: [] as string[], query: 'orchard' },
  tasks: [],
  outputs: [
    { jobId: 'fake/orchard', text: 'orchard apple '.repeat(12) },
    { jobId: 'fake/river', text: 'river 雪 '.repeat(12) },
  ],
  byteBudget: 110,
});
let out: string;
let err: string;

beforeEach(() => {
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

const stream = (value: unknown): Readable => Readable.from([JSON.stringify(value)]);

describe('context pack query override', () => {
  it('selects different relevant context from the same file and stdin snapshot under a tight budget', async () => {
    const input = fixture();
    const text = JSON.stringify(input, null, 2);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pack-query-')));
    const file = path.join(dir, 'snapshot.json');
    try {
      fs.writeFileSync(file, text);
      for (const [query, jobId] of [['orchard', 'fake/orchard'], ['雪 river', 'fake/river']]) {
        out = '';
        expect(await runKnowledgeContextPack(['--file', file, '--query', query])).toBe(0);
        const expected = buildNodeContextPack({ ...input, node: { ...input.node, query } });
        expect(out).toBe(expected);
        expect(JSON.parse(out.trim())).toMatchObject({ jobId, truncated: true });
        expect(Buffer.byteLength(out)).toBeLessThanOrEqual(input.byteBudget);
        const fileOutput = out;
        out = '';
        expect(await runKnowledgeContextPack(['--stdin', '--query', query], stream(input))).toBe(0);
        expect(out).toBe(fileOutput);
      }
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
      expect(input.node.query).toBe('orchard');
      expect(err).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the snapshot query when no override is supplied', async () => {
    const input = fixture();
    expect(await runKnowledgeContextPack(['--stdin'], stream(input))).toBe(0);
    expect(out).toBe(buildNodeContextPack(input));
    expect(JSON.parse(out.trim()).jobId).toBe('fake/orchard');
  });

  it('accepts 2000 Unicode code points and treats query text as data', async () => {
    const input = fixture();
    const query = '雪'.repeat(1999) + '🌍';
    expect(await runKnowledgeContextPack(['--stdin', '--query', query], stream(input))).toBe(0);
    expect(out).toBe(buildNodeContextPack({ ...input, node: { ...input.node, query } }));
    out = '';
    const literal = 'river $(touch /fake/never) https://example.invalid/雪';
    expect(await runKnowledgeContextPack(['--stdin', '--query', literal], stream(input))).toBe(0);
    expect(out).toBe(buildNodeContextPack({ ...input, node: { ...input.node, query: literal } }));
  });

  it.each([
    [], [''], [' \t\n'], ['雪'.repeat(2001)], ['🌍'.repeat(2001)],
    ['--json'], ['river', '--query', 'orchard'], ['--query', 'river'],
  ])('rejects invalid or repeated query arguments %j before reading input', async (...values) => {
    const input = new Readable({ read() { throw new Error('unexpected read'); } });
    expect(await runKnowledgeContextPack(['--stdin', '--query', ...values], input)).toBe(2);
    expect(input.readableDidRead).toBe(false);
    expect(out).toBe('');
    expect(err).toContain('error:');
    input.destroy();
  });

  it('validates the snapshot before applying a valid query', async () => {
    const input = { ...fixture(), node: { ...fixture().node, query: 42 } };
    expect(await runKnowledgeContextPack(['--stdin', '--query', 'river'], stream(input))).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('invalid shape');
  });

  it('composes with reports and required upstream checks, including missing citations', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['fake/missing', 'fake/missing'];
    expect(await runKnowledgeContextPack(['--stdin', '--query', 'river', '--json', '--report', '--require-upstream'], stream(input))).toBe(1);
    const pack = buildNodeContextPack({ ...input, node: { ...input.node, query: 'river' } });
    expect(JSON.parse(out)).toEqual({
      v: 1, jobId: input.node.jobId, pack, bytes: Buffer.byteLength(pack),
      report: { requestedByteBudget: input.byteBudget, emittedBytes: Buffer.byteLength(pack), emittedRecordCount: 1,
        citedJobIds: ['fake/river'], truncatedRecordCount: 1 },
      check: { missingUpstreamJobIds: ['fake/missing'] },
    });
    expect(err).toBe('');
    input.node.upstreamJobIds = ['fake/river'];
    out = '';
    expect(await runKnowledgeContextPack(['--stdin', '--query', 'orchard', '--json', '--report', '--require-upstream'], stream(input))).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ report: { citedJobIds: ['fake/river'] }, check: { missingUpstreamJobIds: [] } });
  });

  it('documents the query override', async () => {
    expect(await runKnowledgeContextPack(['--help'])).toBe(0);
    expect(out).toContain('--query <text>');
    expect(out).toContain('2000 Unicode code points');
  });
});
