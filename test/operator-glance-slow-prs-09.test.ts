import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatOperatorGlance, isOperatorGlance, type OperatorGlance } from '../src/core/fleet/operator-glance.js';
import { readOperatorGlance } from '../src/core/fleet/operator-glance-read.js';

const base: OperatorGlance = {
  v: 1, at: '2026-11-04T00:00:00.000Z', running: 2, target: 4, usagePct: 10, resetsAt: null,
  mergesToday: 5, main: 'up', incidents: [],
};
const at = Date.parse(base.at);

describe('glance slow PRs line', () => {
  it('adds no line for zero or an absent field', () => {
    const plain = formatOperatorGlance(base, at);
    expect(formatOperatorGlance({ ...base, slowPrs: { count: 0, repos: [] } }, at)).toBe(plain);
    expect(plain).not.toContain('Slow PRs');
  });

  it('lists one repo by short name after the merges line', () => {
    const lines = formatOperatorGlance({ ...base, slowPrs: { count: 3, repos: [{ repo: 'example/demo', count: 3 }] } }, at).split('\n');
    expect(lines[lines.indexOf('Merges 5 today.') + 1]).toBe('Slow PRs: 3 open over 30 min (demo 3).');
  });

  it('shows three names then +1 more for four repos', () => {
    const repos = ['a', 'b', 'c', 'd'].map((n) => ({ repo: `example/${n}`, count: 1 }));
    expect(formatOperatorGlance({ ...base, slowPrs: { count: 4, repos } }, at))
      .toContain('Slow PRs: 4 open over 30 min (a 1, b 1, c 1 +1 more).');
  });
});

describe('isOperatorGlance slowPrs', () => {
  it('accepts absent and valid', () => {
    expect(isOperatorGlance(base)).toBe(true);
    expect(isOperatorGlance({ ...base, slowPrs: { count: 1, repos: [{ repo: 'example/demo', count: 1 }] } })).toBe(true);
  });
  it('rejects malformed', () => {
    expect(isOperatorGlance({ ...base, slowPrs: { count: -1, repos: [] } })).toBe(false);
    expect(isOperatorGlance({ ...base, slowPrs: { count: 1.5, repos: [] } })).toBe(false);
    expect(isOperatorGlance({ ...base, slowPrs: { count: 1, repos: [{ repo: 7, count: 1 }] } })).toBe(false);
  });
});

describe('readOperatorGlance slowPrs', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const setup = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'glance-slow-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    return dir;
  };
  const read = (runsDir: string) => readOperatorGlance({ runsDir, busRoot: runsDir, now: () => new Date('2026-11-04T01:00:00Z') });

  it('counts a PR open 40 minutes before the newest row, without URLs', async () => {
    const dir = setup();
    const rows = [
      { ts: '2026-11-04T00:00:00Z', class: 'pr', url: 'https://github.com/example/demo/pull/1' },
      { ts: '2026-11-04T00:40:00Z', class: 'other' },
    ];
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const glance = await read(dir);
    expect(glance.slowPrs).toEqual({ count: 1, repos: [{ repo: 'example/demo', count: 1 }] });
    expect(JSON.stringify(glance)).not.toContain('github.com');
  });

  it('leaves slowPrs undefined when the ledger is missing', async () => {
    expect((await read(setup())).slowPrs).toBeUndefined();
  });

  it('leaves slowPrs undefined when the ledger is a symlink', async () => {
    const dir = setup();
    writeFileSync(join(dir, 'real.jsonl'), '{"ts":"2026-11-04T00:00:00Z","class":"pr","url":"https://github.com/example/demo/pull/1"}\n');
    symlinkSync(join(dir, 'real.jsonl'), join(dir, 'metrics', 'jobs.jsonl'));
    expect((await read(dir)).slowPrs).toBeUndefined();
  });
});
