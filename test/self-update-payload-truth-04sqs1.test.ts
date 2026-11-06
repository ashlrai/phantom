/**
 * self-update payload truth (RQ-PHX-UPDATEPAYLOADTRUTH04SQS1) — exit 0 is not
 * an update. The spawned `update --json` must prove the outcome with the
 * producer's own shapes (src/cli/update.ts): `updated:true` is the only
 * success signal, `updated:false` + `upToDate:true` is already-current, and
 * every other payload — empty, malformed, null, array, wrong-typed or
 * negative — is a failed apply with restart.required=false. Before this
 * guard the same payloads were reported as `updated` with a restart request.
 * Fake runner, temp resultPath; no real git/node/npm, no restart.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applySelfUpdate,
  selfUpdateApplyInProgress,
  type SelfUpdateApplyDeps,
  type SelfUpdateApplyResult,
  type SelfUpdateRunResult,
  type SelfUpdateRunner,
} from '../src/core/verse/self-update-apply.js';
import { readSelfUpdateLastApply } from '../src/core/verse/self-update-last.js';

const CLI_ENTRY = '/repo/phantom/dist/cli/index.js';
const UPDATE_ARGS = `${CLI_ENTRY} update --json`;
// The durable reader validates commits as 40–64 hex, so the fakes speak full SHAs.
const FROM = 'a'.repeat(40), TO = 'b'.repeat(40);
const FF = [
  ['status --porcelain', {}],
  ['fetch origin master', {}],
  ['rev-parse HEAD', { stdout: `${FROM}\n` }],
  ['rev-parse origin/master', { stdout: `${TO}\n` }],
  ['merge-base --is-ancestor HEAD origin/master', {}],
] as const;

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'selfupdate-truth-')); });
afterEach(() => { vi.unstubAllEnvs(); });

/** Ordered playback: `args.join(' ')` must equal each script key; an unscripted call fails as exit 42. */
function depsFor(script: ReadonlyArray<readonly [string, Partial<SelfUpdateRunResult>]>): SelfUpdateApplyDeps {
  const queue = [...script];
  const runner: SelfUpdateRunner = {
    run: async (_cmd, args) => {
      const next = queue.shift();
      return next && args.join(' ') === next[0]
        ? { code: 0, stdout: '', stderr: '', timedOut: false, ...next[1] }
        : { code: 42, stdout: '', stderr: `unscripted call ${args.join(' ')}`, timedOut: false };
    },
  };
  let t = Date.parse('2026-11-04T21:54:00Z');
  return { runner, repoRoot: '/repo/phantom', cliEntry: CLI_ENTRY, resultPath: join(home, 'verse', 'self-update-last.json'), now: () => (t += 100) };
}

/** A clean fast-forward apply whose updater exits 0 with the given stdout. */
async function applyWithUpdaterStdout(stdout: string): Promise<{ result: SelfUpdateApplyResult; persisted: ReturnType<typeof readSelfUpdateLastApply> }> {
  const deps = depsFor([...FF, [UPDATE_ARGS, { stdout }]]);
  const result = await applySelfUpdate(deps);
  return { result, persisted: readSelfUpdateLastApply(deps.resultPath!) };
}

describe('update payload truth', () => {
  it.each([
    ['empty stdout', ''],
    ['whitespace only', '  \n \t '],
    ['non-JSON text', 'Update complete — restart now'],
    ['truncated JSON', '{"updated":'],
    ['JSON null', 'null'],
    ['JSON array of a positive report', '[{"updated":true,"versionAfter":"9.9.9"}]'],
    ['JSON string', '"updated"'],
    ['string-typed flags', JSON.stringify({ updated: 'true', upToDate: 'false' })],
    ['numeric flags', JSON.stringify({ updated: 1, upToDate: 0 })],
    ['null updated flag', JSON.stringify({ updated: null, upToDate: true })],
    ['explicit negative (blocked/degraded shape)', JSON.stringify({ updated: false, upToDate: null, blocked: true })],
    ['update available but not applied', JSON.stringify({ updated: false, upToDate: false })],
    ['missing flags', '{}'],
  ])('fails and never requests a restart on %s', async (_label, stdout) => {
    const { result, persisted } = await applyWithUpdaterStdout(stdout);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('invalid update report');
    expect(result.restart.required).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: 'update', ok: false });
    expect(persisted?.outcome).toBe('failed');
    expect(persisted?.restartRequired).toBe(false);
  });

  it('keeps the diagnostic bounded and never echoes raw stdout', async () => {
    const marker = `MARKER-${'x'.repeat(4000)}`;
    const { result } = await applyWithUpdaterStdout(`partial write ${marker}`);
    expect(result.outcome).toBe('failed');
    const note = result.steps.at(-1)!.note;
    expect(note).toBe('updater stdout is not a JSON report');
    expect(note!.length).toBeLessThan(120);
    expect(JSON.stringify(result)).not.toContain('MARKER');
  });

  it('reports the rejection category for each invalid payload class', async () => {
    const cases: Array<[string, RegExp]> = [
      ['', /exited 0 without output/],
      ['not json', /not a JSON report/],
      [JSON.stringify({ updated: false, upToDate: null }), /updated=false, upToDate null/],
      [JSON.stringify({ updated: false, upToDate: false }), /updated=false, upToDate false/],
      [JSON.stringify({ updated: false }), /updated=false, upToDate absent/],
      [JSON.stringify({}), /report\.updated is absent/],
      [JSON.stringify({ updated: 'true' }), /report\.updated is type string/],
    ];
    for (const [stdout, pattern] of cases) {
      const { result } = await applyWithUpdaterStdout(stdout);
      expect(result.steps.at(-1)!.note).toMatch(pattern);
    }
  });

  it('applies the producer updated shape and persists a restart request', async () => {
    const { result, persisted } = await applyWithUpdaterStdout(JSON.stringify({
      updated: true, upToDate: false, newCommits: null,
      versionBefore: '1.0.0', versionAfter: '9.9.9',
      commitBefore: FROM, commitAfter: TO,
      remotes: ['origin'], branch: 'master',
      symlink: null, smokeOk: true,
      message: 'update applied successfully', error: null,
    }));
    expect(result.outcome).toBe('updated');
    expect(result.toCommit).toBe(TO);
    expect(result.steps.at(-1)).toMatchObject({ name: 'update', ok: true, note: 'updated to 9.9.9' });
    expect(result.restart.required).toBe(true);
    expect(persisted).toMatchObject({ outcome: 'updated', restartRequired: true, fromCommit: FROM, toCommit: TO });
  });

  it('accepts a minimal {updated:true} payload as positive evidence', async () => {
    const { result } = await applyWithUpdaterStdout(JSON.stringify({ updated: true }));
    expect(result.outcome).toBe('updated');
    expect(result.restart.required).toBe(true);
  });

  it('reads the npm-channel installed shape {updated:true,versionLatest}', async () => {
    const { result } = await applyWithUpdaterStdout(JSON.stringify({ channel: 'npm', updated: true, versionLatest: '2.0.0' }));
    expect(result.outcome).toBe('updated');
    expect(result.steps.at(-1)!.note).toBe('updated to 2.0.0');
  });

  it('keeps the producer already-current shape already-current', async () => {
    const { result, persisted } = await applyWithUpdaterStdout(JSON.stringify({
      updated: false, upToDate: true, newCommits: 0,
      versionBefore: '1.0.0', versionAfter: '1.0.0',
      commitBefore: FROM, commitAfter: FROM,
      remotes: ['origin'], branch: 'master',
      symlink: null, smokeOk: true,
      message: 'already up to date', error: null,
    }));
    expect(result.outcome).toBe('already-current');
    expect(result.restart.required).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: 'update', ok: true, note: 'already up to date' });
    expect(persisted).toMatchObject({ outcome: 'already-current', restartRequired: false });
  });

  it('clears the in-flight apply after a failed payload so the next apply can succeed', async () => {
    const bad = depsFor([...FF, [UPDATE_ARGS, { stdout: '' }]]);
    const r1 = await applySelfUpdate(bad);
    expect([r1.outcome, r1.restart.required]).toEqual(['failed', false]);
    expect(selfUpdateApplyInProgress()).toBeNull();

    const good = depsFor([...FF, [UPDATE_ARGS, { stdout: JSON.stringify({ updated: true, upToDate: false, commitAfter: TO, versionAfter: '9.9.9' }) }]]);
    const r2 = await applySelfUpdate(good);
    expect([r2 === r1, r2.outcome, r2.restart.required]).toEqual([false, 'updated', true]);
    expect(readSelfUpdateLastApply(good.resultPath!)).toMatchObject({ outcome: 'updated', restartRequired: true });
    expect(selfUpdateApplyInProgress()).toBeNull();
  });
});
