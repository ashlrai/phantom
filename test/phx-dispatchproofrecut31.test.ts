import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet.js';
import { readDispatchProof } from '../src/cli/fleet-dispatch-proof.js';
import { dispatchManifestDir, type DispatchManifestAssignment, type DispatchManifestEvent } from '../src/core/fleet/dispatch-manifest.js';

let root: string;
let runs: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-proof-recut-'));
  runs = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'store'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const assignment = (itemId: string, attemptId?: string): DispatchManifestAssignment => ({
  itemId, ...(attemptId ? { attemptId } : {}),
  source: 'test', repo: '/fixture/repo', title: 'fixture', backend: 'codex',
});
function event(manifestId: string, itemIds: string[], dryRun = false): DispatchManifestEvent {
  return { schemaVersion: 1, manifestId, ts: '2026-10-31T00:00:00.000Z', mode: 'concurrent', dryRun,
    claimedItemIds: itemIds, assignments: itemIds.map(id => assignment(id)),
    unassigned: [], slots: { codex: itemIds.length }, backendCounts: { codex: itemIds.length },
    counts: { claimed: itemIds.length, assigned: itemIds.length, unassigned: 0 } };
}
function manifests(events: DispatchManifestEvent[]) {
  mkdirSync(dispatchManifestDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(dispatchManifestDir(), '2026-10-31.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
}
function claims(text: string) {
  mkdirSync(join(runs, 'queue'), { recursive: true });
  writeFileSync(join(runs, 'queue/claimed.tsv'), text);
}
const claim = (id: string) => `${id}\tcodex-personal\tfrontier\t00:00\t1793404800\n`;

describe('fleet dispatch-proof recut: proven matches and unmatched intent', () => {
  it('proves an assignment whose itemId exactly matches a claimed job', async () => {
    manifests([event('m-one', ['JOB-1'])]);
    claims(claim('JOB-1'));
    const proof = await readDispatchProof(runs);
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-1']);
    expect(proof.matchingEvidence.matches).toHaveLength(1);
    expect(proof.matchingEvidence.matches[0]).toMatchObject({
      manifestId: 'm-one', itemId: 'JOB-1', evidence: 'exact-item-job-id',
    });
    expect(proof.unmatchedIntent).toEqual([]);
    expect(proof.unmatchedClaims).toEqual([]);
  });
  it('lists an assignment with no claim as unmatched and keeps the unknown reasons explicit', async () => {
    manifests([event('m-two', ['JOB-1', 'JOB-2'])]);
    claims(claim('JOB-1'));
    const proof = await readDispatchProof(runs);
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-1']);
    expect(proof.unmatchedIntent.map(a => a.itemId)).toEqual(['JOB-2']);
    expect(proof.unknownReasons.join(' ')).toContain('Unmatched intent means unobserved in these sources, not proof of zero launches');
    expect(proof.unknownReasons.join(' ')).toContain('not proof of process launch or completion');
  });
  it('excludes conflicting manifest ids from both matches and unmatched intent', async () => {
    manifests([
      { ...event('conflict', ['JOB-1']), ts: '2026-10-31T00:00:00.000Z' },
      { ...event('conflict', ['JOB-2']), ts: '2026-10-31T01:00:00.000Z' },
      event('clean', ['JOB-3']),
    ]);
    claims(claim('JOB-1') + claim('JOB-3'));
    const proof = await readDispatchProof(runs);
    expect(proof.summary.conflictingManifests).toBe(1);
    expect(proof.matchingEvidence.matches.map(m => m.itemId)).toEqual(['JOB-3']);
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-3']);
    expect(proof.unmatchedIntent.map(a => a.itemId)).toEqual([]);
    expect(proof.summary.live.assigned).toBe(1);
    expect(proof.unmatchedClaims.map(c => c.job)).toEqual(['JOB-1']);
    expect(proof.unknownReasons.join(' ')).toContain('Conflicting manifest IDs are excluded');
  });
  it('counts equivalent duplicate manifest rows once', async () => {
    manifests([event('same', ['JOB-1']), event('same', ['JOB-1'])]);
    claims(claim('JOB-1'));
    const proof = await readDispatchProof(runs);
    expect(proof.summary.conflictingManifests).toBe(0);
    expect(proof.summary.live.assigned).toBe(1);
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-1']);
  });
  it('reaches the module through cmdFleet and prints the acceptance envelope', async () => {
    manifests([event('m-acc', ['JOB-1', 'JOB-2'])]);
    claims(claim('JOB-1'));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    expect(await cmdFleet(['dispatch-proof', '--json', '--runs-dir', runs])).toBe(0);
    const proof = JSON.parse(output.trim());
    expect(proof.schemaVersion).toBe(1);
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-1']);
    expect(proof.matchingEvidence.matches).toHaveLength(1);
    expect(proof.unmatchedIntent.map((a: { itemId: string }) => a.itemId)).toEqual(['JOB-2']);
    expect(proof.unknownReasons.length).toBeGreaterThan(0);
  });
  it('documents its flags in --help and exits 2 on invalid flags', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleet(['dispatch-proof', '--help'])).toBe(0);
    expect(output.join('\n')).toContain('--json');
    expect(output.join('\n')).toContain('--runs-dir');
    expect(await cmdFleet(['dispatch-proof', '--bogus'])).toBe(2);
    expect(await cmdFleet(['dispatch-proof', '--runs-dir', 'relative/path'])).toBe(2);
  });
});
