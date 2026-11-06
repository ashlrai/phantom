import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runHarnessBetExport } from '../examples/agents/harness-bet-export.js';
import { parseHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

const now = new Date('2026-10-31T12:00:00Z');
const args = ['--file', 'fixture.md', '--source', 'S1', '--takeaway', '1'];
const entry = (checked = '2026-10-31', note = 'Review [evidence](https://example.test/citation).') => `## S1 — Fixture
- Checked: ${checked}.
- Source: [source](https://example.test/source)
- Takeaway: ${note}
`;

async function run(markdown: string, options: string[] = args) {
  let output = '';
  const read = vi.fn((_file: string, date: Date) => parseHarnessDigest(markdown, date));
  const status = await runHarnessBetExport(options, { read, now: () => now, output: text => { output += text; } });
  return { status, value: JSON.parse(output), read };
}

describe('harness bet export', () => {
  it('exports one selected takeaway with its citations and empty leader fields', async () => {
    const result = await run(entry() + '- Takeaway: Another [citation](https://example.test/other).\n',
      ['--takeaway', '2', '--source', 'S1', '--file', 'fixture.md']);
    expect(result.status).toBe(0);
    expect(result.value).toEqual({ v: 1, source: { id: 'S1', checkedAt: '2026-10-31', stale: false,
      urls: ['https://example.test/source'] }, takeaway: { number: 2, text: 'Another [citation](https://example.test/other).' },
    goal: '', acceptance: [] });
    expect(result.read).toHaveBeenCalledWith('fixture.md', now);
  });

  it('refuses absent takeaways and absent sources', async () => {
    expect(await run(entry(), [...args.slice(0, -1), '2'])).toMatchObject({ status: 3, value: { error: { reason: 'takeaway_not_found' } } });
    expect(await run(entry(), ['--file', 'fixture.md', '--source', 'S2', '--takeaway', '1']))
      .toMatchObject({ status: 3, value: { error: { reason: 'source_not_found' } } });
  });

  it('refuses duplicate IDs even when only one occurrence is otherwise valid', async () => {
    const result = await run(entry() + '## S1 — Duplicate\n- Takeaway: Other\n');
    expect(result).toMatchObject({ status: 3, value: { error: { reason: 'ambiguous_source' } } });
  });

  it('refuses stale sources by default and explicitly labels included stale sources', async () => {
    expect(await run(entry('2026-10-23'))).toMatchObject({ status: 3, value: { error: { reason: 'stale_source' } } });
    expect(await run(entry('2026-10-23'), [...args, '--include-stale']))
      .toMatchObject({ status: 0, value: { source: { stale: true, checkedAt: '2026-10-23' } } });
    expect(await run(entry('2026-10-24'))).toMatchObject({ status: 0, value: { source: { stale: false } } });
  });

  it('refuses invalid sources, including malformed sections sharing the selected ID', async () => {
    for (const text of [entry('2026-02-30'), entry('2026-11-01'), entry().replace(/- Source:.*\n/, ''),
      entry() + '## S1\n']) {
      expect(await run(text, [...args, '--include-stale'])).toMatchObject({ status: 3, value: { error: { reason: 'invalid_source' } } });
    }
    expect(await run(entry() + '## S2\n')).toMatchObject({ status: 0 });
  });

  it('refuses clipped takeaways and oversized output', async () => {
    expect(await run(entry('2026-10-31', 'x'.repeat(4097)))).toMatchObject({ status: 3, value: { error: { reason: 'takeaways_truncated' } } });
    const hugeUrl = 'https://example.test/' + 'x'.repeat(65_536);
    expect(await run(entry().replace('https://example.test/source', hugeUrl)))
      .toMatchObject({ status: 3, value: { error: { reason: 'output_too_large' } } });
  });

  it('validates options before reading and emits bounded JSON errors', async () => {
    for (const options of [[], [...args, '--extra'], [...args, '--source', 'S1'], [...args, '--include-stale', '--include-stale'],
      ['--file', 'x', '--source', 'S1', '--takeaway', '0'], ['--file', 'x', '--source', 'S1', '--takeaway', '21'],
      [...args, '--wait-ms', '30001'], [...args, '--wait-ms', '0']]) {
      const result = await run(entry(), options);
      expect(result).toMatchObject({ status: 2, value: { error: { reason: 'invalid_arguments' } } });
      expect(result.read).not.toHaveBeenCalled();
    }
    let output = '';
    expect(await runHarnessBetExport(args, { read: () => null, output: text => { output += text; } })).toBe(1);
    expect(JSON.parse(output)).toEqual({ error: { reason: 'digest_unreadable' } });
    expect(output).not.toContain('fixture.md');
  });

  it('uses an injected finite wait and honors cancellation without reading', async () => {
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const read = vi.fn(() => parseHarnessDigest(entry(), now));
    const output = vi.fn();
    expect(await runHarnessBetExport([...args, '--wait-ms', '5'], { wait, read, now: () => now, output })).toBe(0);
    expect(wait).toHaveBeenCalledWith(5, expect.any(AbortSignal));
    const controller = new AbortController();
    const cancelledWait = vi.fn(async () => { controller.abort(); });
    read.mockClear();
    expect(await runHarnessBetExport([...args, '--wait-ms', '5'], { wait: cancelledWait, read, output, signal: controller.signal })).toBe(130);
    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({ error: { reason: 'interrupted' } });
  });

  it('reads a local fixture without executing digest text or fetching URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bet-export-'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const marker = join(dir, 'executed');
      const file = join(dir, 'digest.md');
      const hostile = `$(touch ${marker})`;
      writeFileSync(file, entry('2000-01-01', hostile));
      let output = '';
      const status = await runHarnessBetExport(['--file', file, '--source', 'S1', '--takeaway', '1', '--include-stale'],
        { now: () => now, output: text => { output += text; } });
      expect(status).toBe(0);
      expect(JSON.parse(output).takeaway.text).toBe(hostile);
      expect(existsSync(marker)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
  });
});
