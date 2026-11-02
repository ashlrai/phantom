import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

let out: string;
let err: string;

beforeEach(() => {
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

function fixture(): NodeContextPackInput {
  return {
    node: { jobId: 'fake/current', upstreamJobIds: ['fake/a', 'fake/b'] },
    tasks: [{ jobId: 'fake/b', text: 'Task B' }],
    outputs: [{ jobId: 'fake/a', text: 'Output A' }],
    byteBudget: 4096,
  };
}

async function run(input: NodeContextPackInput, ...flags: string[]): Promise<number> {
  return runKnowledgeContextPack(['--stdin', ...flags], Readable.from([JSON.stringify(input)]));
}

function result(): { v: number; jobId: string; pack: string; bytes: number; check: { missingUpstreamJobIds: string[] } } {
  return JSON.parse(out) as ReturnType<typeof result>;
}

describe('context pack required upstream citations', () => {
  it('accepts task and output citations and combines the check with the report', async () => {
    const input = fixture();
    expect(await run(input, '--json', '--require-upstream', '--report')).toBe(0);
    expect(result()).toMatchObject({ v: 1, jobId: 'fake/current', pack: buildNodeContextPack(input),
      check: { missingUpstreamJobIds: [] }, report: { citedJobIds: ['fake/a', 'fake/b'] } });
    expect(err).toBe('');
  });

  it('returns a partial pack and distinct missing IDs in dependency order', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['fake/missing-b', 'fake/a', 'fake/missing-a', 'fake/missing-b', 'fake/a'];
    expect(await run(input, '--require-upstream', '--json')).toBe(1);
    expect(result().check.missingUpstreamJobIds).toEqual(['fake/missing-b', 'fake/missing-a']);
    expect(result().pack).toBe(buildNodeContextPack(input));
    expect(result().pack).toContain('fake/a');
    expect(err).toBe('');
  });

  it('treats a self-ID like any other dependency based on emitted citations', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['fake/current'];
    input.outputs = [{ jobId: 'fake/current', text: 'Own output' }];
    input.tasks = [];
    expect(await run(input, '--json', '--require-upstream')).toBe(1);
    expect(result().check.missingUpstreamJobIds).toEqual(['fake/current']);
    out = '';
    input.tasks = [{ jobId: 'fake/current', text: 'Own task' }];
    expect(await run(input, '--json', '--require-upstream')).toBe(0);
    expect(result().check.missingUpstreamJobIds).toEqual([]);
    expect(result().pack).toContain('Own task');
    expect(result().pack).not.toContain('Own output');
  });

  it('accepts an empty dependency list even with an empty pack', async () => {
    const input = fixture();
    input.node.upstreamJobIds = [];
    input.tasks = []; input.outputs = []; input.byteBudget = 1;
    expect(await run(input, '--json', '--require-upstream')).toBe(0);
    expect(result()).toEqual({ v: 1, jobId: 'fake/current', pack: '', bytes: 0, check: { missingUpstreamJobIds: [] } });
  });

  it('checks emitted records after a multibyte budget omits an available upstream', async () => {
    const input = fixture();
    input.outputs = [{ jobId: 'fake/a', text: '雪🌍'.repeat(50) }, { jobId: 'fake/b', text: 'Available B' }];
    input.tasks = [];
    const first = JSON.stringify({ jobId: 'fake/a', kind: 'output', text: '雪🌍', truncated: true }) + '\n';
    input.byteBudget = Buffer.byteLength(first, 'utf8');
    expect(input.byteBudget).toBeGreaterThan(first.length);
    expect(await run(input, '--json', '--require-upstream')).toBe(1);
    expect(result().pack).toBe(first);
    expect(result().bytes).toBe(input.byteBudget);
    expect(result().check.missingUpstreamJobIds).toEqual(['fake/b']);
  });

  it('rejects the flag without JSON before reading and rejects duplicate flags', async () => {
    const stream = new Readable({ read() { throw new Error('unexpected read'); } });
    expect(await runKnowledgeContextPack(['--stdin', '--require-upstream'], stream)).toBe(2);
    expect(stream.readableDidRead).toBe(false);
    expect(out).toBe('');
    expect(err).toContain('--require-upstream requires --json');
    stream.destroy();
    err = '';
    expect(await run(fixture(), '--json', '--require-upstream', '--require-upstream')).toBe(2);
    expect(err).toContain('Unexpected argument or flag');
  });

  it('preserves no-flag output and exit status even for missing dependencies', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['fake/missing'];
    expect(await run(input)).toBe(0);
    expect(out).toBe(buildNodeContextPack(input));
    out = '';
    expect(await run(input, '--json')).toBe(0);
    expect(JSON.parse(out)).toEqual({ v: 1, jobId: input.node.jobId, pack: buildNodeContextPack(input),
      bytes: Buffer.byteLength(buildNodeContextPack(input), 'utf8') });
  });

  it('keeps the partial envelope when routed through the knowledge command', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pack-check-')));
    try {
      const file = path.join(dir, 'snapshot.json');
      const input = fixture();
      input.node.upstreamJobIds = ['fake/a', 'fake/missing'];
      fs.writeFileSync(file, JSON.stringify(input));
      expect(await cmdKnowledge(['context-pack', '--file', file, '--json', '--require-upstream'])).toBe(1);
      const lines = out.trimEnd().split('\n').map(line => JSON.parse(line) as unknown);
      expect(lines).toEqual([
        { v: 1, jobId: input.node.jobId, pack: buildNodeContextPack(input),
          bytes: Buffer.byteLength(buildNodeContextPack(input), 'utf8'), check: { missingUpstreamJobIds: ['fake/missing'] } },
        { error: true, exitCode: 1 },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('documents the flag and the limits of the check', async () => {
    expect(await runKnowledgeContextPack(['--help'])).toBe(0);
    expect(out).toContain('--require-upstream requires --json');
    expect(out).toContain('not completion or trust');
  });
});
