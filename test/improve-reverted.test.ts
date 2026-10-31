import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVERT_LOG_FORMAT,
  REVERT_WINDOW_MS,
  detectRevertOutcomes,
  revertOutcomeOf,
  revertOutcomeRecords,
  revertedOutcomeKeys,
  type RevertCandidate,
} from '../src/core/improve/reverted.js';
import type { ObserveExec } from '../src/core/improve/observe.js';

const MERGE = 'a'.repeat(40);
const OTHER_MERGE = 'b'.repeat(40);
const REVERT = 'c'.repeat(40);
const UNRELATED = 'd'.repeat(40);
const RELAND = 'e'.repeat(40);
const MERGED_AT = '2026-10-27T00:00:00+00:00';
const plus = (hours: number) => new Date(Date.parse(MERGED_AT) + hours * 3_600_000).toISOString();

/** One REVERT_LOG_FORMAT row: sha, committer time, body. */
const commit = (sha: string, at: string, body: string) => `${sha}\x1f${at}\x1f${body}\x1e`;

const pr5: RevertCandidate = { repository: 'ashlrai/phantom', number: 5, mergeSha: MERGE };

describe('revert outcome records (72h window)', () => {
  it('detects a revert within 72h of merge and ignores an unrelated commit', () => {
    const log = [
      commit(UNRELATED, plus(50), `follow-up notes on ${MERGE}`),
      commit(REVERT, plus(10), `Revert "faster gate (#5)"\n\nThis reverts commit ${MERGE}.`),
      commit(MERGE, MERGED_AT, 'faster gate (#5)'),
      commit(OTHER_MERGE, plus(-2), 'earlier work (#4)'),
    ].join('');
    const record = revertOutcomeOf(log, pr5);
    expect(record).toMatchObject({
      repository: 'ashlrai/phantom', number: 5, pr: 'ashlrai/phantom#5',
      mergeSha: MERGE, mergedAt: new Date(MERGED_AT).toISOString(),
      revertedBy: REVERT, revertedAt: plus(10), relandedBy: null,
    });
    expect(record!.revertLatencyMs).toBe(10 * 3_600_000);
    // The same history holds no revert for a different merge.
    expect(revertOutcomeOf(log, { repository: 'ashlrai/phantom', number: 4, mergeSha: OTHER_MERGE })).toBeNull();
  });

  it('recognises GitHub revert-PR bodies and honours the window edge', () => {
    const at72 = revertOutcomeOf(
      [commit(REVERT, plus(72), `Revert "x"\n\nReverts ashlrai/phantom#5`), commit(MERGE, MERGED_AT, 'x (#5)')].join(''), pr5);
    expect(at72!.revertLatencyMs).toBe(REVERT_WINDOW_MS);
    const pastWindow = revertOutcomeOf(
      [commit(REVERT, plus(73), `Revert "x"\n\nThis reverts commit ${MERGE}.`), commit(MERGE, MERGED_AT, 'x (#5)')].join(''), pr5);
    expect(pastWindow).toBeNull();
  });

  it('marks a re-landed change without dropping the record', () => {
    const log = [
      commit(RELAND, plus(20), `Revert "Revert \\"x\\""\n\nThis reverts commit ${REVERT}.`),
      commit(REVERT, plus(10), `Revert "x"\n\nThis reverts commit ${MERGE}.`),
      commit(MERGE, MERGED_AT, 'x (#5)'),
    ].join('');
    expect(revertOutcomeOf(log, pr5)).toMatchObject({ revertedBy: REVERT, relandedBy: RELAND });
  });

  it('bounds the window by the candidate mergedAt when the merge is outside the scanned range', () => {
    const range = [commit(REVERT, plus(10), `This reverts commit ${MERGE}.`)].join('');
    expect(revertOutcomeOf(range, pr5)).toBeNull();
    expect(revertOutcomeOf(range, { ...pr5, mergedAt: MERGED_AT })).toMatchObject({ mergedAt: new Date(MERGED_AT).toISOString(), revertedBy: REVERT });
  });

  it('emits one record per reverted candidate and exposes the router key set', () => {
    const log = [
      commit(REVERT, plus(10), `This reverts commit ${MERGE}.`),
      commit(OTHER_MERGE, plus(5), 'other (#6)'),
      commit(MERGE, MERGED_AT, 'x (#5)'),
    ].join('');
    const records = revertOutcomeRecords(log, [pr5, { repository: 'ashlrai/phantom', number: 6, mergeSha: OTHER_MERGE }]);
    expect(records.map((r) => r.pr)).toEqual(['ashlrai/phantom#5']);
    expect([...revertedOutcomeKeys(records)]).toEqual(['ashlrai/phantom#5']);
  });

  it('detectRevertOutcomes reads the fixture history an exec returns and reports exec failures', () => {
    const log = [
      commit(REVERT, plus(10), `This reverts commit ${MERGE}.`),
      commit(MERGE, MERGED_AT, 'x (#5)'),
    ].join('');
    let called: string[] = [];
    const exec: ObserveExec = (cmd, args) => { called = [cmd, ...args]; return log; };
    expect(detectRevertOutcomes([pr5], '/repo', 'refs/remotes/origin/main', exec).records).toHaveLength(1);
    expect(called).toContain(`--format=${REVERT_LOG_FORMAT}`);
    expect(detectRevertOutcomes([pr5], '/repo', 'main', () => { throw new Error('not a repo\nstack'); }))
      .toEqual({ records: [], errors: ['log main: not a repo'] });
    expect(detectRevertOutcomes([], '/repo', 'main', exec)).toEqual({ records: [], errors: [] });
  });

  it('detects a real revert in a fixture checkout history', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-reverted-')));
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
      fs.writeFileSync(path.join(repo, 'a.txt'), '2'); git('commit', '-qam', 'change (#7)');
      const merge = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, 'b.txt'), '1'); git('add', '.'); git('commit', '-qm', 'unrelated');
      git('revert', '--no-edit', merge);
      const revert = git('rev-parse', 'HEAD');
      const { records, errors } = detectRevertOutcomes([{ repository: 'ashlrai/phantom', number: 7, mergeSha: merge }], repo, 'HEAD');
      expect(errors).toEqual([]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ pr: 'ashlrai/phantom#7', revertedBy: revert, relandedBy: null });
      expect(records[0]!.revertLatencyMs).toBeLessThanOrEqual(REVERT_WINDOW_MS);
      expect(records[0]!.revertLatencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
