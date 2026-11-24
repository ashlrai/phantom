import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ gh: vi.fn() }));
vi.mock('../src/core/integrations/secrets.js', async (original) => ({
  ...await original<typeof import('../src/core/integrations/secrets.js')>(),
  credentialExecFile: mocks.gh,
}));
vi.mock('../src/core/plugins/registry.js', () => ({ getPluginScanners: async () => [] }));
import { buildBacklog, createBacklogScanSnapshot } from '../src/core/portfolio/backlog.js';
import { listIssuesAsync, githubCiStatusAsync, runGhAsync } from '../src/core/integrations/github.js';

let root: string;
let repos: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backlog-snapshot-'));
  repos = ['a', 'b'].map(name => {
    const repo = join(root, name);
    mkdirSync(repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    return repo;
  });
  mocks.gh.mockReset().mockImplementation((_bin, args, _opts, callback) => {
    setTimeout(() => callback(null, args[0] === 'repo' ? '{"nameWithOwner":"acme/repo"}' : '[]'), 15);
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = () => ({ repos, persist: false, listPendingProposals: () => [], cfg: { foundry: { feedbackEnabled: false } } });

it('reuses remote query promises across concurrent and later real backlog scans', async () => {
  const snapshot = createBacklogScanSnapshot();
  await Promise.all([buildBacklog({ ...options(), snapshot }), buildBacklog({ ...options(), snapshot })]);
  await buildBacklog({ ...options(), snapshot, invalidate: { repos } });
  const calls = () => mocks.gh.mock.calls.filter(([bin]) => bin === 'gh');
  expect(calls()).toHaveLength(repos.length * 3);
  const queries = calls().map(([, args, opts]) => JSON.stringify([opts.cwd, args]));
  expect(new Set(queries).size).toBe(queries.length);
  expect(calls().every(([, args]) => args[0] !== 'pr')).toBe(true);
  await buildBacklog(options());
  expect(calls()).toHaveLength(repos.length * 6);
});

it('keeps the event loop responsive while the async gh read is pending', async () => {
  let timerFired = false;
  let ghSettled = false;
  const timer = new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 1));
  const pending = runGhAsync(repos[0]!, ['issue', 'list']);
  void pending.then(() => { ghSettled = true; });
  await timer;
  expect(timerFired).toBe(true);
  expect(ghSettled).toBe(false);
  expect(await pending).toBe('[]');
});

it('shares issue validation and safely degrades malformed, failed and cancelled reads', async () => {
  expect(await listIssuesAsync(repos[0]!, { limit: 0 })).toEqual([]);
  expect(mocks.gh).not.toHaveBeenCalled();
  mocks.gh.mockImplementation((_bin, _args, _opts, callback) => callback(null, 'not json'));
  expect(await listIssuesAsync(repos[0]!)).toEqual([]);
  expect(await githubCiStatusAsync(repos[0]!)).toEqual({ isRepo: false, repo: null, ci: 'none' });
  mocks.gh.mockImplementation(() => { throw new Error('missing gh'); });
  expect(await runGhAsync(repos[0]!, [])).toBeNull();
  const controller = new AbortController(); controller.abort();
  mocks.gh.mockClear();
  expect(await runGhAsync(repos[0]!, [], controller.signal)).toBeNull();
  expect(mocks.gh).not.toHaveBeenCalled();
});
