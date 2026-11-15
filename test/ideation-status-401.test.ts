import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIdeationStatus } from '../src/cli/fleet-ideation-status.js';
import { readIdeationStatus } from '../src/core/research/ideation-status.js';

const NOW = new Date('2026-11-15T10:00:00Z');
let root: string, cfg: string, state: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ideation-status-'));
  state = join(root, 'state');
  cfg = join(root, 'config.json');
  const p = (n: string) => join(root, n);
  writeFileSync(cfg, JSON.stringify({ repoRoot: p('repo'), reposRoot: p('repos'), queue: p('queue.md'), state, jobs: p('jobs'),
    vitals: p('vitals'), resources: p('res'), research: p('research') }));
  mkdirSync(join(root, 'repo', 'docs', 'strategy'), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

const seed = () => {
  mkdirSync(state);
  writeFileSync(join(state, '2026-11-14.result.json'), JSON.stringify({ day: '2026-11-14', ids: ['p-1', 'p-2', 'p-3'], result: {}, archived: [{ x: 1 }], markdown: 'SECRET-MARKDOWN' }));
  writeFileSync(join(root, 'repo', 'docs', 'strategy', 'IDEATION-2026-11-14.md'), 'SECRET-MARKDOWN');
  writeFileSync(join(state, '2026-11-13.request.json'), JSON.stringify({ day: '2026-11-13', prompt: 'SECRET-PROMPT' }));
  writeFileSync(join(state, '2026-11-11.result.json'), '{not json');
};

describe('readIdeationStatus', () => {
  it('reports completed, scheduled, absent and unknown days', async () => {
    seed();
    const r = await readIdeationStatus(cfg, { now: NOW, days: 5 });
    expect(r).toMatchObject({ v: 1, authority: 'none', stateDir: 'present', lastCompleted: '2026-11-14', streakMissing: 1 });
    expect(r.rows.map(x => [x.day, x.state])).toEqual([['2026-11-15', 'absent'], ['2026-11-14', 'completed'], ['2026-11-13', 'scheduled'], ['2026-11-12', 'absent'], ['2026-11-11', 'unknown']]);
    expect(r.rows[1]).toMatchObject({ session: 'RQ-IDEATION-20261114', selected: ['p-1', 'p-2', 'p-3'], archivedCount: 1, strategyDoc: true });
    expect(r.rows[0]!.strategyDoc).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|markdown|prompt/);
  });
  it('counts the missing streak from the newest day', async () => {
    seed();
    const r = await readIdeationStatus(cfg, { now: new Date('2026-11-16T01:00:00Z'), days: 3 });
    expect(r.streakMissing).toBe(2);
    expect(r.lastCompleted).toBe('2026-11-14');
  });
  it('treats a missing state dir as all absent', async () => {
    const r = await readIdeationStatus(cfg, { now: NOW, days: 30 });
    expect(r.stateDir).toBe('missing');
    expect(r.rows).toHaveLength(30);
    expect(r.rows.every(x => x.state === 'absent')).toBe(true);
    expect(r).toMatchObject({ lastCompleted: null, streakMissing: 30 });
  });
  it('rejects an unparsable config', async () => {
    writeFileSync(cfg, '{}');
    await expect(readIdeationStatus(cfg)).rejects.toThrow();
  });
});

describe('cmdFleetIdeationStatus', () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const code = await cmdFleetIdeationStatus(args, { read: (c, days) => readIdeationStatus(c, { now: NOW, days }) });
    return { code, out: out.join('') };
  };
  it('exits 2 on bad arguments', async () => {
    expect((await run(['--config', 'rel.json'])).code).toBe(2);
    expect((await run(['--config', cfg, '--days', '0'])).code).toBe(2);
    expect((await run(['--config', cfg, '--days', '31'])).code).toBe(2);
    expect((await run(['--config', cfg, '--bogus'])).code).toBe(2);
  });
  it('prints a JSON report', async () => {
    seed();
    const { code, out } = await run(['--config', cfg, '--days', '3', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).rows).toHaveLength(3);
    expect(out).not.toMatch(/SECRET/);
  });
  it('prints one human line per day plus a summary', async () => {
    seed();
    const { out } = await run(['--config', cfg, '--days', '2']);
    expect(out).toContain('2026-11-14  completed  3 selected  doc');
    expect(out.trim().split('\n')).toHaveLength(3);
  });
  it('prints unavailable and exits 1 on a bad config', async () => {
    writeFileSync(cfg, 'nope');
    const { code, out } = await run(['--config', cfg]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ status: 'unavailable' });
  });
});
