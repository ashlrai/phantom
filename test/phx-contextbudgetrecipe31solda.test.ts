import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../examples/context-budget-selection.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';
import { readNodeContextCitations } from '../src/core/fleet/node-context-citations.js';
import { summarizeNodeContextCoverage } from '../src/core/fleet/node-context-coverage.js';

// root -> left/right -> join: the caller resolves the join's predecessor IDs.
function diamond(): NodeContextPackInput {
  return {
    node: { jobId: 'diamond/join', upstreamJobIds: ['diamond/left', 'diamond/right'] },
    tasks: [{ jobId: 'diamond/left', text: 'Left branch' },
      { jobId: 'diamond/right', text: 'Right branch' }],
    outputs: [{ jobId: 'diamond/left', text: 'racine 🌱 雪' },
      { jobId: 'diamond/right', text: 'résultat 🌍'.repeat(90) }],
    byteBudget: 8192,
  };
}

type Row = { jobId: string; kind: string; text: string; truncated: boolean };
type Attempt = { budget: number; bytes: number; coverage: Array<{ jobId: string; state: string }>;
  citations: ReturnType<typeof readNodeContextCitations>; incompleteOutputJobIds: string[] };
type Result = { status: string; chosenBudget: number; bytes: number; pack: string;
  citations: ReturnType<typeof readNodeContextCitations>; attempts: Attempt[]; error: { code: string } };

let root: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'context-budget-selection-'));
  file = join(root, 'snapshot.json');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function run(snapshot: unknown, budgets: string): { code: number; result: Result } {
  writeFileSync(file, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot), { mode: 0o600 });
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const code = main(['--file', file, '--budgets', budgets]);
  vi.restoreAllMocks();
  return { code, result: JSON.parse(out) as Result };
}

describe('context budget selection recipe', () => {
  it('selects the first complete diamond pack, with real bytes, citations and coverage', () => {
    const input = diamond();
    const largest = Buffer.byteLength(buildNodeContextPack({ ...input, tasks: [] }), 'utf8');
    const full = buildNodeContextPack({ ...input, byteBudget: largest });
    const budgets = [150, largest - 1, largest, largest + 1];
    const { code, result } = run(input, budgets.join(','));
    expect(code).toBe(0);
    expect(result.status).toBe('ready');
    expect(result.chosenBudget).toBe(largest);
    expect(result.attempts.map(attempt => attempt.budget)).toEqual(budgets.slice(0, 3));
    expect(result.pack).toBe(full);
    expect(result.bytes).toBe(largest);
    expect(result.bytes).toBe(Buffer.byteLength(result.pack, 'utf8'));
    expect(result.bytes).toBeGreaterThan(result.pack.length);
    expect(result.citations).toEqual(readNodeContextCitations(result.pack));
    expect(result.citations).toContainEqual({ jobId: 'diamond/right', kind: 'output', truncated: false });
    for (const attempt of result.attempts) {
      const pack = buildNodeContextPack({ ...input, byteBudget: attempt.budget });
      expect(attempt.bytes).toBe(Buffer.byteLength(pack, 'utf8'));
      expect(attempt.bytes).toBeLessThanOrEqual(attempt.budget);
      expect(attempt.coverage).toEqual(summarizeNodeContextCoverage(input, pack).upstream);
      expect(attempt.citations).toEqual(readNodeContextCitations(pack));
      for (const row of pack.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row)) {
        const source = (row.kind === 'output' ? input.outputs : input.tasks).find(item => item.jobId === row.jobId)!;
        expect(source.text.startsWith(row.text)).toBe(true);
        expect(row.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
        if (!row.truncated) expect(row.text).toBe(source.text);
      }
    }
    expect(result.attempts[1]!.coverage).toContainEqual({ jobId: 'diamond/right', state: 'truncated' });
    expect(result.attempts[2]!.coverage.every(row => row.state === 'included')).toBe(true);
  });

  it('reports missing output even when that job has a complete task citation', () => {
    const input = diamond();
    input.outputs = input.outputs.filter(row => row.jobId !== 'diamond/right');
    const { code, result } = run(input, '500,8192');
    expect(code).toBe(1);
    expect(result.status).toBe('insufficient');
    expect(result.attempts).toHaveLength(2);
    for (const attempt of result.attempts) {
      expect(attempt.coverage).toContainEqual({ jobId: 'diamond/right', state: 'missing-output' });
      expect(attempt.citations).toContainEqual({ jobId: 'diamond/right', kind: 'task', truncated: false });
    }
    expect(result).not.toHaveProperty('pack');
  });

  it('requires all distinct nonblank output records, not just one included record per job', () => {
    const input = diamond();
    input.outputs = [input.outputs[0]!, { jobId: 'diamond/left', text: 'second 🌊'.repeat(80) }, input.outputs[1]!];
    const largest = Buffer.byteLength(buildNodeContextPack({ ...input, tasks: [] }));
    const firstOnly = Buffer.byteLength(JSON.stringify({ jobId: 'diamond/left', kind: 'output',
      text: input.outputs[0]!.text, truncated: false }) + '\n');
    const { code, result } = run(input, `${firstOnly},${largest}`);
    expect(code).toBe(0);
    expect(result.chosenBudget).toBe(largest);
    expect(result.attempts[0]!.coverage[0]).toEqual({ jobId: 'diamond/left', state: 'included' });
    expect(result.attempts[0]!.incompleteOutputJobIds).toContain('diamond/left');
  });

  it.each(['', '0', '100,100', '200,100', '01', '32769', Array(17).fill('1').join(','), '1,NaN'])(
  'rejects invalid budget list %s', budgets => {
    const { code, result } = run(diamond(), budgets);
    expect(code).toBe(2);
    expect(result.error.code).toBe('INVALID_ARGUMENTS');
  });

  it('rejects invalid snapshots, unsafe identity joins and self dependencies', () => {
    const input = diamond();
    for (const invalid of ['{', { ...input, unexpected: true }, { ...input, outputs: [{ jobId: 'a', text: 'x'.repeat(262145) }] },
      { ...input, node: { ...input.node, jobId: 'fake@example.com' } },
      { ...input, node: { ...input.node, upstreamJobIds: ['diamond/join'] } }]) {
      const { code, result } = run(invalid, '100');
      expect(code).toBe(2);
      expect(result.error.code).toBe('INVALID_SNAPSHOT');
    }
  });

  it('runs as a standalone command and exits 1 for an insufficient snapshot', () => {
    const input = diamond();
    input.outputs = [];
    writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    const child = spawnSync(process.execPath, ['--import', 'tsx', resolve('examples/context-budget-selection.ts'),
      '--file', file, '--budgets', '128,512'], { encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stderr).toBe('');
    expect((JSON.parse(child.stdout) as Result).status).toBe('insufficient');
  }, 30000);
});
