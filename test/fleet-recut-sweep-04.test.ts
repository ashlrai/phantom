import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DirtyRow } from '../src/core/fleet/dirty-landed-inspect.js';
import { cmdFleetRecutSweep } from '../src/cli/fleet-recut-sweep.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
vi.mock('../src/core/fleet/dirty-landed-inspect.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/dirty-landed-inspect.js')>(),
  withScratchRepo: async <T>(fn: (dir: string) => Promise<T>) => fn('/unused'),
  inspectDirtyLanded: async (_dir: string, row: DirtyRow) => ({ number: row.number, title: row.title,
    head: row.headSha, base: 'master', class: row.number === 11 ? 'landed' : 'needs-recut',
    changedPaths: ['src/fake.ts'], landedPaths: [], remainingPaths: row.number === 11 ? [] : ['src/fake.ts'] }),
}));
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'recut-test-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home); vi.stubEnv('HOME', home);
  const runs = join(root, 'runs'), drop = join(root, 'drop');
  let day = 0, report: any;
  const gh = async () => ({ ok: true, stderr: '', stdout: JSON.stringify([13, 11, 12].map(number => ({
    number, title: 'bridge: RQ-PHX-FAKE', headRefOid: 'a'.repeat(40), baseRefName: 'master', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
  }))) });
  const run = (args: string[] = []) => cmdFleetRecutSweep(['--json', '--runs-dir', runs, ...args], {
    gh, remote: '/unused', dropRoot: drop, now: () => day * 86400000, output: t => { report = JSON.parse(t); }, error: () => {},
  });
  return { run, root, runs, drop, report: () => report, nextDay: () => { day++; } };
}
it('registers the verb', () => expect(resolveFleetSubcommand('recut-sweep')).toEqual({ module: './fleet-recut-sweep.js', exportName: 'cmdFleetRecutSweep' }));
it('dry run lists exact paths oldest first and writes nothing', async () => {
  const s = setup(); expect(await s.run()).toBe(0);
  expect(s.report().planned).toEqual([12, 13].map(pr => ({ pr, id: `RECUT${pr}0101`, remainingPaths: ['src/fake.ts'] })));
  expect(existsSync(s.runs)).toBe(false); expect(existsSync(s.drop)).toBe(false);
});
it('writes once per head even on a later UTC day, never dropping landed work', async () => {
  const s = setup(); expect(await s.run(['--apply'])).toBe(0); expect(s.report().written).toBe(2);
  expect(readdirSync(join(s.drop, 'leader/drop/claude'))).toHaveLength(2);
  expect(readFileSync(join(s.runs, 'queue/recut-sweep.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  s.nextDay(); expect(await s.run(['--apply'])).toBe(0);
  expect(s.report().written).toBe(0);
  expect(s.report().skipped).toContainEqual({ pr: 12, reason: 'already-recut' });
  expect(s.report().skipped).toContainEqual({ pr: 11, reason: 'class' });
});
it('skips existing desktop ids', async () => {
  const s = setup(); mkdirSync(join(s.drop, 'leader/drop/claude'), { recursive: true });
  writeFileSync(join(s.drop, 'leader/drop/claude/RQ-PHX-RECUT120101.md'), 'fake');
  expect(await s.run(['--apply'])).toBe(0);
  expect(s.report().skipped).toContainEqual({ pr: 12, reason: 'exists' });
});
it('stops at a full queue', async () => {
  const s = setup(); const q = join(s.drop, 'queue/prompts'); mkdirSync(q, { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(q, `RQ-PHX-FAKE${i}.md`), 'fake');
  expect(await s.run(['--apply'])).toBe(0); expect(s.report().written).toBe(0);
  expect(s.report().skipped).toContainEqual({ pr: 12, reason: 'full' });
  expect(s.report().planned).toHaveLength(1);
});
it('rejects usage and read failures', async () => {
  const s = setup(); expect(await s.run(['--limit', '6'])).toBe(2);
  expect(await cmdFleetRecutSweep(['--json'], { gh: async () => ({ ok: false, stdout: '', stderr: 'fake' }), output: () => {} })).toBe(1);
});
