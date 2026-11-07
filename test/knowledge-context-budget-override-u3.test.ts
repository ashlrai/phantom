import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';

const snapshot = () => ({
  node: { jobId: 'current', upstreamJobIds: ['first', 'second', 'second'] },
  tasks: [{ jobId: 'current', text: 'current task' }],
  outputs: [{ jobId: 'first', text: '雪🌍"\\\n'.repeat(80) }, { jobId: 'second', text: 'second result' }],
  byteBudget: 4096,
});
let dir: string;
let file: string;
let out: string;
let err: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-budget-')));
  file = path.join(dir, 'snapshot.json');
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function stream(text: string): Readable { return Readable.from([Buffer.from(text)]); }

describe('knowledge context-pack budget override', () => {
  it('uses the same UTF-8 bound for file and stdin, reports it, and leaves the file unchanged', async () => {
    const data = snapshot();
    const text = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, text);
    const flags = ['--byte-budget', '100', '--json', '--report'];
    expect(await runKnowledgeContextPack(['--file', file, ...flags])).toBe(0);
    const fileOutput = out;
    const result = JSON.parse(out) as { pack: string; bytes: number; report: { requestedByteBudget: number; emittedBytes: number } };
    expect(result.pack).toBe(buildNodeContextPack({ ...data, byteBudget: 100 }));
    expect(result.bytes).toBe(Buffer.byteLength(result.pack, 'utf8'));
    expect(result.bytes).toBeLessThanOrEqual(100);
    expect(JSON.parse(result.pack.trim())).toMatchObject({ jobId: 'first', truncated: true });
    expect(result.report).toMatchObject({ requestedByteBudget: 100, emittedBytes: result.bytes });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    out = '';
    expect(await runKnowledgeContextPack(['--stdin', ...flags], stream(text))).toBe(0);
    expect(out).toBe(fileOutput);
    expect(err).toBe('');
  });

  it('retains the snapshot budget without the flag and accepts both override boundaries', async () => {
    const data = snapshot();
    const text = JSON.stringify(data);
    expect(await runKnowledgeContextPack(['--stdin', '--json', '--report'], stream(text))).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ pack: buildNodeContextPack(data), report: { requestedByteBudget: 4096 } });
    for (const budget of [1, 65536]) {
      out = '';
      expect(await runKnowledgeContextPack(['--stdin', '--byte-budget', String(budget), '--json', '--report'], stream(text))).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ pack: buildNodeContextPack({ ...data, byteBudget: budget }), report: { requestedByteBudget: budget } });
    }
  });

  it.each([
    [], ['--json'], ['0'], ['65537'], ['-1'], ['1.5'], ['1e2'], ['+1'], [' 1'], ['NaN'],
    ['999999999999999999999999'], ['10', '--byte-budget', '20'],
  ])('rejects invalid, missing, or duplicate override %j before reading input', async (...values) => {
    const input = new Readable({ read() { throw new Error('unexpected read'); } });
    expect(await runKnowledgeContextPack(['--stdin', '--byte-budget', ...values], input)).toBe(2);
    expect(input.readableDidRead).toBe(false);
    expect(out).toBe('');
    expect(err).toContain('error:');
    input.destroy();
  });

  it('still validates the snapshot budget before applying an override', async () => {
    expect(await runKnowledgeContextPack(['--stdin', '--byte-budget', '100'], stream(JSON.stringify({ ...snapshot(), byteBudget: 0 })))).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('invalid shape or byteBudget');
  });

  it('returns the partial pack and exit 1 when the tight override omits upstream citations', async () => {
    const data = snapshot();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream(JSON.stringify(data)) as typeof process.stdin);
    expect(await cmdKnowledge(['context-pack', '--stdin', '--byte-budget', '100', '--json', '--report', '--require-upstream'])).toBe(1);
    const [resultLine, errorLine] = out.trim().split('\n');
    const result = JSON.parse(resultLine) as { pack: string; bytes: number; check: { missingUpstreamJobIds: string[] }; report: { requestedByteBudget: number } };
    expect(result.pack).toBe(buildNodeContextPack({ ...data, byteBudget: 100 }));
    expect(result.bytes).toBeLessThanOrEqual(100);
    expect(result.check.missingUpstreamJobIds).toEqual(['second']);
    expect(result.report.requestedByteBudget).toBe(100);
    expect(JSON.parse(errorLine)).toEqual({ error: true, exitCode: 1 });
  });

  it('documents the override in help', async () => {
    expect(await runKnowledgeContextPack(['--help'])).toBe(0);
    expect(out).toContain('--byte-budget N');
    expect(out).toContain('1 through 65536');
  });
});
