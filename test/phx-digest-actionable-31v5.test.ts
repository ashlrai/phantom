import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-digest-actionable-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:36:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const path = join(dir, 'digest.md');
  writeFileSync(path, [
    '## S1 — Fresh takeaway', '- Checked: 2026-10-31.', '- Source: [Fake](https://example.test/1)', '- Takeaway: Keep a record.',
    '## S2 — Stale citation', '- Checked: 2026-10-23.', '- Source: [Fake](https://example.test/2)',
    '## S3 — Stale takeaway', '- Checked: 2026-10-23.', '- Source: [Fake](https://example.test/3)', '- Takeaway: Review changes.',
    '## S4 — Fresh issue', '- Checked: 2026-10-31.', '- Takeaway: Find a citation.',
    '## S5 — Empty takeaway', '- Checked: 2026-10-31.', '- Source: [Fake](https://example.test/5)', '- Takeaway:   ',
    '## S6 — Issue without takeaway', '- Checked: 2026-10-31.',
    '## Sx — Malformed',
  ].join('\n'));
  return path;
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('harness digest actionable selection', () => {
  it('preserves default JSON and filters only sources with retained takeaways', async () => {
    const args = ['--file', fixture(), '--json'];
    const full = await run(args);
    expect(full.code).toBe(0);
    expect(JSON.parse(full.out)).toEqual({ v: 1, sources: [
      { id: 'S1', title: 'Fresh takeaway', checkedAt: '2026-10-31', urls: ['https://example.test/1'], stale: false, takeaways: ['Keep a record.'] },
      { id: 'S2', title: 'Stale citation', checkedAt: '2026-10-23', urls: ['https://example.test/2'], stale: true },
      { id: 'S3', title: 'Stale takeaway', checkedAt: '2026-10-23', urls: ['https://example.test/3'], stale: true, takeaways: ['Review changes.'] },
      { id: 'S4', title: 'Fresh issue', checkedAt: '2026-10-31', urls: [], stale: false, takeaways: ['Find a citation.'] },
      { id: 'S5', title: 'Empty takeaway', checkedAt: '2026-10-31', urls: ['https://example.test/5'], stale: false },
      { id: 'S6', title: 'Issue without takeaway', checkedAt: '2026-10-31', urls: [], stale: false },
    ], issues: [
      { id: 'S4', code: 'missing_urls' }, { id: 'S6', code: 'missing_urls' }, { id: 'Sx', code: 'malformed_id' },
    ] });
    const data = JSON.parse(full.out);
    const filtered = await run([...args, '--with-takeaways']);
    expect(filtered).toEqual({ code: 0, out: JSON.stringify({ v: 1, sources: [data.sources[0], data.sources[2], data.sources[3]], issues: data.issues }) + '\n', err: '' });
  });

  it('intersects refresh and takeaway filters in either order while retaining selected issues', async () => {
    const args = ['--file', fixture(), '--json'];
    const full = JSON.parse((await run(args)).out);
    for (const flags of [['--needs-refresh', '--with-takeaways'], ['--with-takeaways', '--needs-refresh']]) {
      const result = await run([...args, ...flags, '--check']);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [full.sources[2], full.sources[3]], issues: full.issues });
    }
    const selected = await run([...args, '--source', 'S4', '--needs-refresh', '--with-takeaways', '--check']);
    expect(selected.code).toBe(1);
    expect(JSON.parse(selected.out)).toEqual({ v: 1, sources: [full.sources[3]], issues: [{ id: 'S4', code: 'missing_urls' }] });
  });

  it('checks the selection before display filtering, even when output is empty', async () => {
    const args = ['--file', fixture(), '--json', '--with-takeaways', '--check'];
    for (const [id, code, issues] of [
      ['S2', 1, []], ['S5', 0, []], ['S6', 1, [{ id: 'S6', code: 'missing_urls' }]], ['S999', 1, []],
    ] as const) {
      const result = await run([...args, '--source', id]);
      expect(result.code).toBe(code);
      expect(JSON.parse(result.out)).toEqual({ v: 1, sources: [], issues });
    }
    expect((await run([...args, '--source', 'S1'])).code).toBe(0);
    expect((await run(args)).code).toBe(1);
  });

  it('rejects repeated flags and documents filtering and check semantics', async () => {
    const result = await run(['--file', fixture(), '--json', '--with-takeaways', '--with-takeaways']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('invalid harness-digest arguments');
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--with-takeaways');
    expect(help.out).toContain('nonempty takeaway arrays');
    expect(help.out).toContain('selection before --needs-refresh and --with-takeaways');
    expect(help.out).toContain('check always evaluates the full digest');
  });

  it('exposes the filter and health status through the executable CLI', () => {
    const path = join(dir, 'process.md');
    writeFileSync(path, '## S1 — Old citation\n- Checked: 2000-01-01.\n- Source: [Fake](https://example.test/1)\n');
    const invoke = (extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'reflect', 'harness-digest', '--file', path, '--json', ...extra], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NO_COLOR: '1' },
    });
    const normal = invoke([]);
    const filtered = invoke(['--with-takeaways', '--check']);
    const duplicate = invoke(['--with-takeaways', '--with-takeaways']);
    expect(normal.status).toBe(0);
    expect(JSON.parse(normal.stdout).sources).toHaveLength(1);
    expect(filtered.status).toBe(1);
    expect(JSON.parse(filtered.stdout)).toEqual({ v: 1, sources: [], issues: [] });
    expect(duplicate.status).toBe(2);
    expect(duplicate.stdout).toBe('');
  }, 30_000);
});
