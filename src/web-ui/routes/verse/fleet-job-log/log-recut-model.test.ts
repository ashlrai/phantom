import { expect, it } from 'vitest';
import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import { backlogVerdict, parseLogPr, recutFromLog } from './log-recut-model.js';

const url = 'https://github.com/ashlrai/phantom/pull/2461';
const nowMs = Date.UTC(2026, 10, 1);
const backlog = (status: string, action: string) => ({ repo: 'ashlrai/phantom', source: 'ok', items: [{ number: 2461, mergeStateStatus: status, suggestedAction: action }] }) as MergeBacklogReadV1;

it('describes backlog verdicts without guessing absent PRs have merged', () => {
  expect(backlogVerdict(url, backlog('DIRTY', 'recut'), nowMs)?.text).toBe('PR #2461 is DIRTY (conflicts) · recut suggested');
  expect(backlogVerdict(url, backlog('BEHIND', 'refresh'), nowMs)?.text).toBe('PR #2461 is BEHIND · the merge pass refreshes it');
  expect(backlogVerdict(url, backlog('MERGED', 'none'), nowMs)?.text).toBe('PR #2461 merged');
  expect(backlogVerdict(url, { ...backlog('DIRTY', 'recut'), items: [] }, nowMs)?.text).toContain('not in the open merge backlog');
  expect(backlogVerdict(url, { ...backlog('DIRTY', 'recut'), source: 'gh-failed' }, nowMs)).toBeNull();
  expect(backlogVerdict('https://evil.test/ashlrai/phantom/pull/2461', backlog('DIRTY', 'recut'), nowMs)).toBeNull();
});

it('creates bounded stable UTC IDs and a safe, complete brief', () => {
  const recut = recutFromLog({ job: 'rq-phx-' + 'x'.repeat(80), prUrl: url, title: 'a title', lane: 'codex', nowMs });
  expect(recut?.id).toMatch(/^[A-Z0-9]{3,40}$/);
  expect(recut?.id).toHaveLength(40);
  expect(recut?.id).toMatch(/R1101$/);
  expect(recut?.lane).toBe('codex-personal');
  expect(recut?.tier).toBe('work');
  for (const text of ['git fetch origin pull/2461/head', 'origin/master', 'src/cli/fleet.ts', 'Keep tests', 'BRIDGE_NOTES.md', 'Closes #2461', 'only if']) expect(recut?.body).toContain(text);
  expect(recutFromLog({ job: 'a', prUrl: 'invalid', title: null, lane: null, nowMs })).toBeNull();
  expect(recutFromLog({ job: 'a', prUrl: url, title: null, lane: null, nowMs: NaN })).toBeNull();
  expect(parseLogPr('https://github.com/ashlrai/phantom/pull/0')).toBeNull();
});
