import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet.js';
import { readDispatchProof } from '../src/cli/fleet-dispatch-proof.js';
import { dispatchManifestDir, type DispatchManifestEvent } from '../src/core/fleet/dispatch-manifest.js';

let root: string;
let runs: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-proof-'));
  runs = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'store'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function event(id: string, itemId: string, dryRun = false): DispatchManifestEvent {
  return { schemaVersion: 1, manifestId: id, ts: '2026-10-31T00:00:00.000Z', mode: 'concurrent', dryRun,
    claimedItemIds: [itemId], assignments: [{ itemId, source: 'test', repo: '/fixture/repo', title: 'fixture', backend: 'codex' }],
    unassigned: [], slots: { codex: 1 }, backendCounts: { codex: 1 }, counts: { claimed: 1, assigned: 1, unassigned: 0 } };
}
function manifests(events: DispatchManifestEvent[], suffix = '') {
  mkdirSync(dispatchManifestDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(dispatchManifestDir(), '2026-10-31.jsonl'), events.map(e => JSON.stringify(e) + '\n').join('') + suffix, { mode: 0o600 });
}
function claims(text: string) {
  mkdirSync(join(runs, 'queue'), { recursive: true });
  writeFileSync(join(runs, 'queue/claimed.tsv'), text);
}
const claim = (id: string) => `${id}\tcodex-personal\tfrontier\t00:00\t1793404800\n`;

describe('fleet dispatch-proof real source evidence', () => {
  it('separates live intent, dry-run intent, matching claims and unobserved assignments', async () => {
    manifests([event('live', 'JOB-1'), event('unseen', 'JOB-2'), event('dry', 'JOB-3', true)]);
    claims(claim('JOB-1') + claim('JOB-3'));
    const proof = await readDispatchProof(runs);
    expect(proof.summary).toMatchObject({ coverage: 'complete', live: { assigned: 2 }, dryRun: { assigned: 1 } });
    expect(proof.sources.manifests.events).toHaveLength(3);
    expect(proof.sources.runs.claimed).toHaveLength(2);
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-1']);
    expect(proof.matchingEvidence.launchCount).toBeNull();
    expect(proof.unmatchedIntent.map(a => a.itemId)).toEqual(['JOB-2']);
    expect(proof.unmatchedClaims.map(c => c.job)).toEqual(['JOB-3']);
    expect(proof.dryRunIntent).toHaveLength(1);
  });
  it('reports absent sources as unknown without creating stores', async () => {
    const proof = await readDispatchProof(runs);
    expect(proof.coverage).toEqual({ manifests: 'unknown', runs: 'missing', claimed: 'missing' });
    expect(proof.unknownReasons.join(' ')).toContain('missing');
    expect(readdirSync(root)).toEqual([]);
  });
  it('retains valid evidence and reports partial sources independently', async () => {
    manifests([event('live', 'JOB-1')], '{torn');
    claims(claim('JOB-1') + 'invalid\n');
    const proof = await readDispatchProof(runs);
    expect(proof.coverage).toEqual({ manifests: 'partial', runs: 'degraded', claimed: 'degraded' });
    expect(proof.summary.sourceQuality.invalidRows).toBe(1);
    expect(proof.matchingEvidence.matches).toHaveLength(1);
    expect(proof.unknownReasons.join(' ')).toContain('unknown');
  });
  it('does not match different identifiers even with identical timestamps or matching attempt IDs', async () => {
    manifests([{ ...event('live', 'OTHER'), assignments: [{ ...event('x', 'OTHER').assignments[0]!, attemptId: 'JOB-1' }] }]);
    claims(claim('JOB-1'));
    const proof = await readDispatchProof(runs);
    expect(proof.matchingEvidence.matches).toEqual([]);
    expect(proof.unmatchedIntent).toHaveLength(1);
    expect(proof.unknownReasons.join(' ')).toContain('no identifier mapping');
  });
  it('deduplicates equal manifests and excludes conflicting IDs from joins', async () => {
    manifests([event('same', 'JOB-1'), event('same', 'JOB-1'), event('conflict', 'JOB-1'), event('conflict', 'JOB-2')]);
    claims(claim('JOB-1'));
    const proof = await readDispatchProof(runs);
    expect(proof.summary.conflictingManifests).toBe(1);
    expect(proof.matchingEvidence.matches).toHaveLength(1);
  });
  it('inspects without permission migration or manifest writes', async () => {
    manifests([event('live', 'JOB-1')]);
    const file = join(dispatchManifestDir(), '2026-10-31.jsonl');
    chmodSync(file, 0o644);
    const before = readFileSync(file, 'utf8');
    await readDispatchProof(runs);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readdirSync(dispatchManifestDir())).toEqual(['2026-10-31.jsonl']);
  });
  it('delegates the CLI and emits one JSON envelope with both projections', async () => {
    manifests([event('live', 'JOB-1')]); claims(claim('JOB-1'));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    expect(await cmdFleet(['dispatch-proof', '--json', '--runs-dir', runs])).toBe(0);
    expect(output.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({ sources: { manifests: { sourcePresent: true }, runs: { runsDirPresent: true } }, matchingEvidence: { matchedJobIds: ['JOB-1'] } });
  });
  it('prints safe command and fleet help, and explains human evidence', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
    expect(await cmdFleet(['dispatch-proof', '--help'])).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect(output.join('\n')).toContain('claims do not prove launches');
    await cmdFleet(['--help']);
    expect(output.join('\n')).toContain('fleet dispatch-proof');
    await cmdFleet(['dispatch-proof', '--runs-dir', runs]);
    expect(output.join('\n')).toContain('Assigned intent:');
    expect(output.join('\n')).toContain('Observed claims:');
  });
  it('refuses unknown options and relative source paths before reading', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleet(['dispatch-proof', '--dispatch'])).toBe(2);
    expect(await cmdFleet(['dispatch-proof', '--runs-dir', 'relative'])).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });
});
