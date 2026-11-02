import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

const fixture = (): NodeContextPackInput => ({
  node: { jobId: 'current', upstreamJobIds: ['first', 'second', 'missing', 'first'] },
  tasks: [{ jobId: 'missing', text: 'task only' }],
  outputs: [{ jobId: 'first', text: '雪🌍"\\\n'.repeat(80) },
    { jobId: 'second', text: 'omitted body /private/example raw prompt' }],
  byteBudget: 120,
});
afterEach(() => vi.restoreAllMocks());

async function run(input: NodeContextPackInput, flags: string[] = []) {
  let out = ''; let err = '';
  const code = await runKnowledgeContextPack(['--stdin', '--json', ...flags],
    Readable.from([JSON.stringify(input)]), {
      stdout: text => { out += text; }, stderr: text => { err += text; },
    });
  return { code, err, value: out ? JSON.parse(out) : undefined };
}

describe('bounded upstream pack explanations', () => {
  it('uses the real CLI file snapshot path and preserves pack bytes under tight and full budgets', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pack-explain-')));
    const file = path.join(dir, 'snapshot.json');
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
    try {
      const input = fixture();
      fs.writeFileSync(file, JSON.stringify(input));
      expect(await cmdKnowledge(['context-pack', '--file', file, '--json', '--explain', '--report',
        '--citations', '--require-complete-upstream-outputs'])).toBe(1);
      // cmdKnowledge also emits its standard error line on a failed coverage check.
      const tight = JSON.parse(out.split('\n')[0]);
      expect(tight.pack).toBe(buildNodeContextPack(input));
      expect(tight.bytes).toBe(Buffer.byteLength(tight.pack));
      expect(tight.bytes).toBeLessThanOrEqual(120);
      expect(tight.explain).toMatchObject({
        eligibleUpstreamOutputJobIds: ['first', 'second'],
        selectedUpstreamOutputJobIds: ['first'], omittedDiagnosticCount: 0,
        upstream: [
          { jobId: 'first', selectedKinds: ['output'], reason: 'selected', outputCoverage: 'truncated' },
          { jobId: 'second', selectedKinds: [], reason: 'budget-omission', outputCoverage: 'omitted' },
          { jobId: 'missing', eligibleOutput: false, reason: 'no-eligible-output' },
        ],
      });
      expect(JSON.stringify(tight.explain)).not.toContain('omitted body');
      expect(JSON.stringify(tight.explain)).not.toContain('/private');
      expect(tight.explain.upstream.map((row: { jobId: string; outputCoverage: string }) =>
        ({ jobId: row.jobId, state: row.outputCoverage }))).toEqual(tight.check.upstreamOutputCoverage);
      const fullInput = { ...input, node: { ...input.node, upstreamJobIds: ['first', 'second'] } };
      const full = await run(fullInput, ['--explain', '--byte-budget', '4096', '--require-complete-upstream-outputs']);
      expect(full.code).toBe(0);
      expect(full.value.explain.upstream.every((row: { outputCoverage: string }) => row.outputCoverage === 'included')).toBe(true);
      expect(full.value.pack).toBe(buildNodeContextPack({ ...fullInput, byteBudget: 4096 }));
      expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(input));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('composes with query override, fairness and Unicode budgets without changing selection or ordering', async () => {
    const input = fixture();
    input.outputs = [...input.outputs, { jobId: 'related', text: 'needle' }];
    for (const fair of [false, true]) {
      for (const budget of [1, 120, 200, 4096]) {
        const flags = ['--query', 'needle', '--byte-budget', String(budget), ...(fair ? ['--fair-upstream'] : [])];
        const plain = await run(input, flags);
        const explained = await run(input, [...flags, '--explain', '--citations', '--report']);
        expect(explained.code).toBe(0);
        expect(explained.value.pack).toBe(plain.value.pack);
        expect(explained.value.pack).toBe(buildNodeContextPack({ ...input, byteBudget: budget,
          fairUpstream: fair, node: { ...input.node, query: 'needle' } }));
        expect(explained.value.bytes).toBeLessThanOrEqual(budget);
        expect(JSON.stringify(explained.value.explain)).not.toContain('needle');
        if (fair && budget === 200) expect(explained.value.explain.selectedUpstreamOutputJobIds).toEqual(['first', 'second']);
        if (budget === 4096) expect(explained.value.citations.records).toContainEqual({ jobId: 'related', kind: 'output', truncated: false });
      }
    }
  });

  it('handles blank outputs and self dependencies conservatively and bounds unsafe or excess diagnostics', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['blank', 'current', '/private/example', 'raw prompt\ntext',
      'x'.repeat(129), ...Array.from({ length: 200 }, (_, i) => `job${i}`)];
    input.outputs = [{ jobId: 'blank', text: ' \n' }, { jobId: 'current', text: 'own output' }];
    const { value } = await run(input, ['--explain']);
    expect(value.explain.upstream.slice(0, 2)).toMatchObject([
      { jobId: 'blank', reason: 'no-eligible-output' }, { jobId: 'current', reason: 'unknown' },
    ]);
    expect(value.explain.upstream.length).toBeLessThanOrEqual(100);
    expect(value.explain.omittedDiagnosticCount + value.explain.upstream.length).toBe(205);
    expect(Buffer.byteLength(JSON.stringify(value.explain))).toBeLessThanOrEqual(16384);
    expect(JSON.stringify(value.explain)).not.toMatch(/private|raw prompt/);
    input.node.upstreamJobIds = Array.from({ length: 100 }, (_, i) => `job${i}${'x'.repeat(120)}`);
    const bounded = (await run(input, ['--explain'])).value.explain;
    expect(bounded.upstream.length).toBeLessThan(100);
    expect(bounded.omittedDiagnosticCount + bounded.upstream.length).toBe(100);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(16384);
  });

  it.each([
    ['--explain'], ['--explain', '--json', '--markdown'], ['--json', '--explain', '--explain'],
    ['--json', '--query', '--explain'],
  ])('rejects invalid flag combinations before reading a snapshot: %j', async flags => {
    const stdin = new Readable({ read() { throw new Error('unexpected read'); } });
    const stdout = vi.fn();
    expect(await runKnowledgeContextPack(['--stdin', ...flags], stdin, { stdout, stderr: vi.fn() })).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stdin.readableDidRead).toBe(false);
    stdin.destroy();
  });
});
