// The backend lane enumerates test/; include the colocated route regression here.
import '../src/core/verse/leader-api.slate.test.js';
import { expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composePlannerSlate, resolvePlannerPreset, defaultPlannerBriefPath, briefCandidates } from '../src/core/fleet/planner-slate-presets.js';
const home = join(tmpdir(), 'preset-home');
const runsRoot = join(tmpdir(), 'preset-runs');
it('composes exact personal Codex argv and searches binaries in priority order', () => {
  const ctx = { home, runsRoot, exists: () => true };
  const codex = resolvePlannerPreset('codex-personal', ctx);
  expect(codex.binary).toBe('/opt/homebrew/bin/codex');
  expect(codex.argv).toEqual(['/usr/bin/env', `CODEX_HOME=${join(home, '.codex-2')}`, codex.binary, 'exec', '-m', 'gpt-6.1-sol', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C', join(home, 'Projects', 'ashlrai', '.orch-drop', 'sol'), '-']);
  expect(resolvePlannerPreset('codex-personal', { ...ctx, exists: path => path === join(home, '.local', 'bin', 'codex') }).binary).toBe(join(home, '.local', 'bin', 'codex'));
  expect(composePlannerSlate(['codex-personal'], join(runsRoot, 'brief'), ctx)).toMatchObject({ v: 1, promptPath: join(runsRoot, 'brief') });
});
it('composes Claude stdin and working-directory wrapper', () => {
  const claude = resolvePlannerPreset('claude', { home, runsRoot, exists: () => true });
  expect(claude.argv).toEqual(['/bin/sh', '-c', 'cd "$0" && exec "$1" -p --model claude-fable-5-1 --dangerously-skip-permissions --add-dir "$2"', join(runsRoot, 'leader', 'drop', 'claude'), join(home, '.local', 'bin', 'claude'), join(home, 'Projects', 'ashlrai', 'phantom')]);
});
it('reports unavailable binaries and rejects invalid preset declarations', () => {
  const ctx = { home, runsRoot, exists: () => false };
  expect(resolvePlannerPreset('claude', ctx)).toMatchObject({ available: false, binary: null, argv: [] });
  expect(composePlannerSlate(['claude'], '/brief', ctx)).toEqual({ error: 'unavailable', preset: 'claude' });
  for (const ids of [[], ['unknown'], ['claude', 'claude'], Array(9).fill('claude')]) expect(() => composePlannerSlate(ids, '/brief', ctx)).toThrow();
});
it('selects default briefs in order and reports absent metadata', () => {
  const paths = [join(runsRoot, 'queue', 'planner-brief.prompt'), join(runsRoot, 'ORCH-sol.prompt'), join(runsRoot, 'ORCH-claude.prompt')];
  for (let i = 0; i < paths.length; i++) expect(defaultPlannerBriefPath(runsRoot, path => paths.slice(i).includes(path))).toBe(paths[i]);
  expect(defaultPlannerBriefPath(runsRoot, () => false)).toBeNull();
  const metadata = briefCandidates(runsRoot, () => ({ mtimeMs: Date.now() - 2000, isFile: () => true }));
  expect(metadata.every(row => row.exists && row.ageSeconds !== null && row.ageSeconds >= 2)).toBe(true);
  expect(briefCandidates(runsRoot, () => { throw Error(); })).toEqual(paths.map(path => ({ path, exists: false, ageSeconds: null })));
});
