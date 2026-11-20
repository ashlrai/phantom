import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLanes } from '../src/cli/lanes.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const last = (out: ReturnType<typeof vi.spyOn>): string => String(out.mock.calls.at(-1)![0]);

describe('phm lanes caps', () => {
  it('prints the table as lanes.caps.v1 with unknown kept unknown', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['caps', '--json'])).toBe(0);
    const report = JSON.parse(last(out));
    expect(report.schema).toBe('lanes.caps.v1');
    const row = (lane: string) => report.lanes.find((l: { lane: string }) => l.lane === lane);
    expect(row('claude').gh).toBe(false);
    expect(row('codex-personal').gh).toBe(true);
    expect(row('gemini').gh).toBeNull();
  });

  it('prints plain words', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['caps'])).toBe(0);
    expect(out.mock.calls.map(c => c[0])).toContain('claude: gh no, network unknown, browser unknown, local_fs_outside_worktree unknown');
  });

  it('--check says which lanes can run a job file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lanes-caps-'));
    dirs.push(dir);
    const file = join(dir, 'job.md');
    await writeFile(file, 'List the open pull requests with `gh pr list` and summarise them.');
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['caps', '--check', file, '--json'])).toBe(0);
    const report = JSON.parse(last(out));
    expect(report.lanes.find((l: { lane: string }) => l.lane === 'claude')).toMatchObject({ ok: false, missing: ['gh'], reason: 'claude lacks gh' });
    expect(report.lanes.find((l: { lane: string }) => l.lane === 'codex-personal')).toMatchObject({ ok: true, missing: [] });
    out.mockClear();
    expect(await cmdLanes(['caps', '--check', file])).toBe(0);
    expect(out.mock.calls.map(c => c[0])).toContain('claude: skipped, claude lacks gh');
  });

  it('rejects bad flags', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdLanes(['caps', '--check'])).toBe(2);
    expect(await cmdLanes(['caps', '--nope'])).toBe(2);
  });
});
