import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BATCH_RULES, MAX_BATCH, batchId, coalesceQueue } from '../src/core/queue/coalesce.js';
import { cmdQueueCoalesce } from '../src/cli/queue-coalesce.js';

const ready = (id: string, repo: string, extra = 'P1, pool=codex-personal, tier=mid', size = 'size<=200') =>
  `- READY ${id} (${extra}, repo=${repo}, ${size}): Extend tests/${repo}/cases.test with a ${id.toLowerCase()} case. Acceptance: the ${id} case passes.`;

/** Shape of the Nov 16 23:31 generator burst: 24 one-case jobs over six repos. */
const burst: Array<[string, number]> = [['locus', 6], ['lexicon', 6], ['ashlr-md', 3], ['ashlr-stack', 4], ['ashlr-plugin', 2], ['phantom-secrets', 3]];
const burstLines = burst.flatMap(([repo, n]) => Array.from({ length: n }, (_, i) => ready(`RQ-${repo.toUpperCase()}${i + 1}A111623Q8`, repo)));
const burstText = ['# Router queue', '', ...burstLines, ''].join('\n');

describe('coalesceQueue', () => {
  it('turns the 24-line burst into six per-repo batches', () => {
    const { report, output } = coalesceQueue(burstText);
    expect(report.batches.map(b => [b.repo, b.replaces.length])).toEqual(burst);
    expect(report.kept).toEqual([]);
    expect(report.malformed).toEqual([]);
    expect(output.match(/^- READY /gm)).toHaveLength(6);
    expect(output.startsWith('# Router queue\n\n')).toBe(true);
    const locus = report.batches[0]!;
    expect(locus.line).toBe(`- READY ${locus.id} (P1, pool=codex-personal, tier=mid, repo=locus, size<=1200): Batch of 6 small locus tasks, replaces ${locus.replaces.join(', ')}. Checklist and rules: prompts/${locus.id}.md`);
    expect(locus.prompt).toContain('1. [ ] RQ-LOCUS1A111623Q8: Extend tests/locus/cases.test with a rq-locus1a111623q8 case.');
    expect(locus.prompt).toContain('   Acceptance: the RQ-LOCUS1A111623Q8 case passes.');
    expect(locus.prompt).toContain('6. [ ] RQ-LOCUS6A111623Q8');
    for (const rule of BATCH_RULES) expect(locus.prompt).toContain(`- ${rule}`);
    // Every member is replaced exactly once and the output is stable on a second pass.
    expect(report.batches.flatMap(b => b.replaces).sort()).toEqual(burstLines.map(l => l.split(' ')[2]).sort());
    expect(coalesceQueue(output).report.batches).toEqual([]);
  });

  it('derives the batch id from the member ids only', () => {
    const ids = ['RQ-B', 'RQ-A'];
    expect(batchId('ashlr-md', ids)).toBe(batchId('ashlr-md', ['RQ-A', 'RQ-B']));
    expect(batchId('ashlr-md', ids)).toMatch(/^RQ-BATCH-ASHLR-MD-[0-9A-F]{8}$/);
    expect(batchId('ashlr-md', ids)).not.toBe(batchId('ashlr-md', ['RQ-A', 'RQ-C']));
    const reversed = [...burstLines].reverse().join('\n');
    expect(new Set(coalesceQueue(reversed).report.batches.map(b => b.id))).toEqual(new Set(coalesceQueue(burstText).report.batches.map(b => b.id)));
  });

  it('passes never-batch lines through unchanged', () => {
    const keep = [
      ready('RQ-URGENT', 'locus', 'P0, pool=codex-personal, tier=mid'),
      ready('RQ-HARD', 'locus', 'P1, pool=codex-personal, tier=frontier'),
      ready('FIXUP-LOCUS-1', 'locus'),
      ready('RQ-FIXUP-locus-12-abcdef0', 'locus'),
      ready('RQ-ORDER', 'locus', 'P1, pool=codex-personal, tier=mid, src=leader'),
      ready('RQ-BIG', 'locus', undefined, 'size<=400'),
      ready('RQ-UNSIZED', 'locus', undefined, 'max-files=3'),
    ];
    const text = [...keep, ready('RQ-ONE', 'locus'), ready('RQ-TWO', 'locus'), ''].join('\n');
    const { report, output } = coalesceQueue(text);
    expect(report.kept).toEqual([
      { id: 'RQ-URGENT', reason: 'P0' }, { id: 'RQ-HARD', reason: 'frontier' }, { id: 'FIXUP-LOCUS-1', reason: 'fixup' },
      { id: 'RQ-FIXUP-locus-12-abcdef0', reason: 'fixup' }, { id: 'RQ-ORDER', reason: 'leader' },
      { id: 'RQ-BIG', reason: 'not small' }, { id: 'RQ-UNSIZED', reason: 'not small' },
    ]);
    expect(report.batches.map(b => b.replaces)).toEqual([['RQ-ONE', 'RQ-TWO']]);
    expect(output.startsWith(keep.join('\n') + '\n')).toBe(true);
  });

  it('never merges across repos, pools or tiers and leaves a single-line repo alone', () => {
    const text = [
      ready('RQ-L1', 'locus'), ready('RQ-X1', 'lexicon'), ready('RQ-L2', 'locus'),
      ready('RQ-P1', 'locus', 'P2, pool=claude, tier=mid'), ready('RQ-T1', 'locus', 'P1, pool=codex-personal, tier=fast'),
    ].join('\n');
    const { report, output } = coalesceQueue(text);
    expect(report.batches.map(b => b.replaces)).toEqual([['RQ-L1', 'RQ-L2']]);
    expect(report.kept.map(k => [k.id, k.reason])).toEqual([['RQ-X1', 'alone'], ['RQ-P1', 'alone'], ['RQ-T1', 'alone']]);
    expect(output.split('\n').slice(1)).toEqual(text.split('\n').filter(l => !l.includes('RQ-L')));
  });

  it('caps a batch at eight and splits the rest', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => ready(`RQ-C${i + 1}`, 'lexicon', i === 3 ? 'P1, pool=codex-personal, tier=mid' : 'P2, pool=codex-personal, tier=mid')).join('\n');
    const eleven = coalesceQueue(lines(11)).report;
    expect(eleven.batches.map(b => b.replaces.length)).toEqual([MAX_BATCH, 3]);
    expect(eleven.batches[0]!.priority).toBe('P1');
    expect(eleven.batches[1]!.priority).toBe('P2');
    expect(eleven.batches[0]!.id).not.toBe(eleven.batches[1]!.id);
    const nine = coalesceQueue(lines(9));
    expect(nine.report.batches.map(b => b.replaces.length)).toEqual([8]);
    expect(nine.report.kept).toEqual([{ id: 'RQ-C9', reason: 'alone' }]);
    expect(nine.output).toContain(ready('RQ-C9', 'lexicon', 'P2, pool=codex-personal, tier=mid'));
  });

  it('keeps malformed lines as they are and reports them', () => {
    const bad = [
      '- READY',
      '- READY RQ-NOFIELDS: do something',
      '- READY RQ-NOGOAL (P1, pool=codex-personal, tier=mid, repo=locus, size<=200)',
      '- READY RQ-NOREPO (P1, pool=codex-personal, tier=mid, size<=200): do something',
      '- READY RQ-NOPRIO (pool=codex-personal, tier=mid, repo=locus, size<=200): do something',
    ];
    const text = [ready('RQ-A', 'locus'), ...bad, ready('RQ-B', 'locus'), ready('RQ-A', 'locus'), '- CLAIMED 09:15 dispatchd RQ-OLD (repo=locus): busy', ''].join('\r\n');
    const { report, output } = coalesceQueue(text);
    expect(report.malformed).toEqual([
      { line: 2, text: bad[0], reason: 'missing id' }, { line: 3, text: bad[1], reason: 'missing (fields)' },
      { line: 4, text: bad[2], reason: 'missing goal' }, { line: 5, text: bad[3], reason: 'missing repo' },
      { line: 6, text: bad[4], reason: 'missing priority' }, { line: 8, text: ready('RQ-A', 'locus'), reason: 'repeated id RQ-A' },
    ]);
    expect(report.batches.map(b => b.replaces)).toEqual([['RQ-A', 'RQ-B']]);
    const rows = output.split('\r\n');
    expect(rows[0]).toBe(report.batches[0]!.line);
    expect(rows.slice(1)).toEqual([...bad, ready('RQ-A', 'locus'), '- CLAIMED 09:15 dispatchd RQ-OLD (repo=locus): busy', '']);
  });
});

describe('phm queue coalesce', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => { log.mockClear(); error.mockClear(); });
  const printed = () => log.mock.calls.map(call => String(call[0]));

  async function queueFile(): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'queue-coalesce-'));
    const file = join(dir, 'router-queue.md');
    await writeFile(file, burstText);
    return { dir, file };
  }

  it('dry-runs by default with JSON or one plain line per batch', async () => {
    const { dir, file } = await queueFile();
    expect(await cmdQueueCoalesce([file, '--json'])).toBe(0);
    const json = JSON.parse(printed()[0]!);
    expect(json).toMatchObject({ schema: 'phantom.queue-coalesce.v1', applied: false, out: null });
    expect(json.batches.map((b: { replaces: string[] }) => b.replaces.length)).toEqual([6, 6, 3, 4, 2, 3]);
    log.mockClear();
    expect(await cmdQueueCoalesce([file])).toBe(0);
    const plain = printed();
    expect(plain.slice(0, 6).every(line => /^RQ-BATCH-[A-Z0-9-]+ replaces \d+ [a-z-]+ jobs: RQ-/.test(line))).toBe(true);
    expect(plain.at(-1)).toMatch(/^Dry run; nothing written/);
    expect(await readdir(dir)).toEqual(['router-queue.md']);
    expect(await readFile(file, 'utf8')).toBe(burstText);
  });

  it('--apply writes originals, the new queue and prompts, and never overwrites', async () => {
    const { dir, file } = await queueFile();
    const out = join(dir, 'plan');
    expect(await cmdQueueCoalesce([file, '--apply', '--out', out, '--json'])).toBe(0);
    const json = JSON.parse(printed()[0]!);
    expect(json).toMatchObject({ applied: true, out });
    expect(await readFile(join(out, 'router-queue.original.md'), 'utf8')).toBe(burstText);
    expect(await readFile(join(out, 'router-queue.md'), 'utf8')).toBe(coalesceQueue(burstText).output);
    const prompts = (await readdir(join(out, 'prompts'))).sort();
    expect(prompts).toEqual(json.batches.map((b: { id: string }) => `${b.id}.md`).sort());
    expect(await readFile(join(out, 'prompts', prompts[0]!), 'utf8')).toContain('Rules:');
    expect(await readFile(file, 'utf8')).toBe(burstText);
    log.mockClear();
    expect(await cmdQueueCoalesce([file, '--apply', '--out', out, '--json'])).toBe(1);
    expect(JSON.parse(printed()[0]!).error).toMatch(/already has a coalesce plan/);
    expect(await readFile(join(out, 'router-queue.original.md'), 'utf8')).toBe(burstText);
  });

  it('rejects --apply without --out and unknown flags', async () => {
    expect(await cmdQueueCoalesce(['x.md', '--apply'])).toBe(2);
    expect(await cmdQueueCoalesce(['x.md', '--out', 'dir'])).toBe(2);
    expect(await cmdQueueCoalesce(['x.md', '--force'])).toBe(2);
    expect(await cmdQueueCoalesce(['--help'])).toBe(0);
  });
});
