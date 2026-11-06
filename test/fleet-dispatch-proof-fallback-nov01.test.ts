import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { dispatchManifestDir, type DispatchManifestEvent } from '../src/core/fleet/dispatch-manifest.js';

let root: string;
let runs: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-proof-fallback-'));
  runs = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'store'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function event(manifestId: string, itemIds: string[]): DispatchManifestEvent {
  return { schemaVersion: 1, manifestId, ts: '2026-11-01T00:00:00.000Z', mode: 'concurrent', dryRun: false,
    claimedItemIds: itemIds, assignments: itemIds.map(itemId => ({ itemId, source: 'test', repo: '/fixture/repo', title: 'fixture', backend: 'codex' })),
    unassigned: [], slots: { codex: itemIds.length }, backendCounts: { codex: itemIds.length },
    counts: { claimed: itemIds.length, assigned: itemIds.length, unassigned: 0 } };
}
function manifests(events: DispatchManifestEvent[]) {
  mkdirSync(dispatchManifestDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(dispatchManifestDir(), '2026-11-01.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
}
function claims(text: string) {
  mkdirSync(join(runs, 'queue'), { recursive: true });
  writeFileSync(join(runs, 'queue/claimed.tsv'), text);
}
const claim = (id: string) => `${id}\tcodex-personal\tfrontier\t00:00\t1793404800\n`;

// fleet.ts has no `dispatch-proof` dispatch line; a non-2 exit proves the
// #2427 convention fallback loaded ./fleet-dispatch-proof.js itself.
describe('fleet dispatch-proof through the convention fallback', () => {
  it('resolves to ./fleet-dispatch-proof.js exporting cmdFleetDispatchProof', async () => {
    const resolved = resolveFleetSubcommand('dispatch-proof');
    expect(resolved).toEqual({ module: './fleet-dispatch-proof.js', exportName: 'cmdFleetDispatchProof' });
    const loaded = await import('../src/cli/fleet-dispatch-proof.js');
    expect(typeof loaded.cmdFleetDispatchProof).toBe('function');
  });
  it('exits 0 and emits the JSON envelope for a consistent manifest', async () => {
    manifests([event('m-fake-ok', ['JOB-FAKE-1', 'JOB-FAKE-2'])]);
    claims(claim('JOB-FAKE-1') + claim('JOB-FAKE-2'));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    expect(await cmdFleet(['dispatch-proof', '--json', '--runs-dir', runs])).toBe(0);
    const proof = JSON.parse(output.trim());
    expect(proof.schemaVersion).toBe(1);
    expect(proof.sources).toMatchObject({ manifests: { sourcePresent: true }, runs: { runsDirPresent: true } });
    expect(proof.matchingEvidence.basis).toBe('exact-item-job-id');
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-FAKE-1', 'JOB-FAKE-2']);
    expect(proof.matchingEvidence.matches).toHaveLength(2);
    expect(proof.matchingEvidence.launchCount).toBeNull();
    expect(proof.unmatchedIntent).toEqual([]);
    expect(proof.unmatchedClaims).toEqual([]);
    expect(proof.unknownReasons.length).toBeGreaterThan(0);
  });
  it('exits 1 and reports an unmatched live claim the manifest never assigned', async () => {
    manifests([event('m-fake-split', ['JOB-FAKE-1'])]);
    claims(claim('JOB-FAKE-1') + claim('JOB-FAKE-9'));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    expect(await cmdFleet(['dispatch-proof', '--json', '--runs-dir', runs])).toBe(1);
    const proof = JSON.parse(output.trim());
    expect(proof.matchingEvidence.matchedJobIds).toEqual(['JOB-FAKE-1']);
    expect(proof.unmatchedClaims.map((c: { job: string }) => c.job)).toEqual(['JOB-FAKE-9']);
    expect(proof.unmatchedIntent).toEqual([]);
  });
});
