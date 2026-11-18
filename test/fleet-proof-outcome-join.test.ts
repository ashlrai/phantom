import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildFleetEvalReport } from '../src/core/fleet/eval-report.js';
import {
  buildProofOutcomeReport,
  formatProofOutcomeReport,
  FLEET_PROOF_OUTCOMES_SCHEMA,
} from '../src/core/fleet/proof-outcome-join.js';
import { proofHash, serializeProofEnvelope, type ProofEnvelope } from '../src/core/fleet/proof-envelope.js';
import { cmdFleetProofOutcomes } from '../src/cli/fleet-eval-report.js';
import { cmdFleetProof } from '../src/cli/fleet-proof.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const FIXTURES = join(__dirname, 'fixtures', 'fleet-eval-report');
const OBS = [
  { mergeCommit: 'aa10000000000000000000000000000000000001', outcome: 'followed-up' as const, confidence: 'deterministic' as const },
  { mergeCommit: 'cc30000000000000000000000000000000000003', outcome: 'regressed' as const, confidence: 'heuristic' as const },
  { mergeCommit: 'ee50000000000000000000000000000000000005', outcome: 'reverted' as const, confidence: 'deterministic' as const },
];
const evalReport = async () => buildFleetEvalReport({
  jobsText: await readFile(join(FIXTURES, 'jobs.jsonl'), 'utf8'),
  prsTexts: [await readFile(join(FIXTURES, 'prs.json'), 'utf8')],
  observations: { sourceState: 'healthy', rows: OBS },
  nowMs: NOW,
});

const envelope = (): ProofEnvelope => ({
  schema: 'fleet.proof.v1', claims: [], evidence: [], verification: [{ cmd: 'npm test', exitCode: 0, summary: 'ok' }],
  diffStats: { files: 2, added: 10, removed: 1 }, riskTier: 'low', reviewerChecklist: ['check'],
});
const files = new Map<string, string>();
function addProof(job: string, text: string, markerDigest = proofHash(text)) {
  files.set(`/r/${job}.proof.1.json`, text);
  files.set(`/r/${job}.publish`, `PROOF ${job}.proof.1.json sha256:${markerDigest}\nRESULT PR x\n`);
}
const read = (path: string) => files.get(path) ?? null;
const prs = (r: ReturnType<typeof buildProofOutcomeReport>, suffix: string) =>
  r.pullRequests.find((p) => p.url.endsWith(suffix))!;

afterEach(() => { files.clear(); vi.restoreAllMocks(); });

describe('buildProofOutcomeReport', () => {
  it('joins proof artifacts to outcomes with honest nulls and proof-vs-outcome scoring', async () => {
    const good = serializeProofEnvelope(envelope());
    addProof('RQ-A', good);                                    // reverted despite verified proof
    addProof('RQ-B', good);                                    // followed-up, proof flagged
    addProof('RQ-C', 'not json');                               // pending, garbage envelope
    addProof('RQ-F', JSON.stringify({ ...envelope(), schema: 'fleet.proof.v2' })); // future schema
    const verify = vi.fn((publish: string) => ({
      schema: 'fleet.proof-review.v1' as const, ok: publish.endsWith('RQ-A.publish'), checklist: [],
      flags: publish.endsWith('RQ-A.publish') ? [] : ['Verification 0: missing or mismatched tool receipt/output'],
    }));
    const report = buildProofOutcomeReport(await evalReport(), '/r', { read, verify });

    expect(report.schema).toBe(FLEET_PROOF_OUTCOMES_SCHEMA);
    expect(report.basedOn).toBe('fleet.eval-report.v1');
    expect(prs(report, '/pull/100')).toMatchObject({
      jobId: 'RQ-A', proofState: 'verified', proofId: `sha256:${proofHash(good)}`, riskTier: 'low',
      diffStats: { files: 2, added: 10, removed: 1 }, verification: { commands: 1, failed: 0 }, flags: 0, predicted: 'wrong',
    });
    expect(prs(report, '/pull/101')).toMatchObject({ proofState: 'needs-review', flags: 1, predicted: 'correct' });
    // Missing artifact: honest null, no prediction.
    expect(prs(report, '/pull/103')).toMatchObject({ jobId: 'RQ-E', proofState: 'absent', proofId: null, riskTier: null, diffStats: null, predicted: null });
    // Unreadable envelope and unknown schema versions never become proof.
    expect(prs(report, '/pull/50')).toMatchObject({ proofState: 'unreadable', proofId: null });
    expect(prs(report, '/pull/9')).toMatchObject({ proofState: 'unreadable', proofId: null });
    expect(prs(report, '/pull/104')).toMatchObject({ jobId: null, proofState: 'unattributed', predicted: null });
    expect(verify).toHaveBeenCalledTimes(2);

    expect(report.totals).toMatchObject({ merged: 8, withProof: 2, verified: 1, unreadable: 2, unattributed: 3, absent: 1 });
    expect(report.prediction).toEqual({ scored: 2, correct: 1, accuracy: 0.5 });
    const verified = report.byProofState.find((g) => g.state === 'verified')!;
    expect(verified).toMatchObject({ merged: 1, resolved: 1, stable: 0, adverse: 1, durabilityRate: 0 });
    expect(report.verifiedLift).toBeLessThan(0.0001);
    expect(formatProofOutcomeReport(report)).toContain('Proof predicted outcome: 1/2 (50.0%)');
  });

  it('rejects a marker digest that does not match the envelope and unsafe job ids', async () => {
    addProof('RQ-A', serializeProofEnvelope(envelope()), 'f'.repeat(64));
    const verify = vi.fn();
    const report = buildProofOutcomeReport(await evalReport(), '/r', { read, verify });
    expect(prs(report, '/pull/100').proofState).toBe('unreadable');
    expect(verify).not.toHaveBeenCalled();
  });

  it('reports every merge as absent when no results dir exists, without mutating the eval report', async () => {
    const base = await evalReport();
    const snapshot = JSON.stringify(base);
    const report = buildProofOutcomeReport(base, null);
    expect(report.resultsDir.state).toBe('absent');
    expect(report.totals.withProof).toBe(0);
    expect(report.verifiedLift).toBeNull();
    expect(report.prediction.accuracy).toBeNull();
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('phm fleet proof outcomes', () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await cmdFleetProofOutcomes(args, {
      read: async (p) => (p.endsWith('jobs.jsonl') ? readFile(join(FIXTURES, 'jobs.jsonl'), 'utf8') : readFile(join(FIXTURES, 'prs.json'), 'utf8')),
      observations: () => ({ sourceState: 'healthy', observations: [] }) as never,
      now: () => NOW,
    });
    return { code, out: out.join('') };
  };

  it('emits fleet.proof-outcomes.v1 JSON', async () => {
    const { code, out } = await run(['--jobs', 'jobs.jsonl', '--prs', 'prs.json', '--results-dir', '/nonexistent-proof-dir', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe('fleet.proof-outcomes.v1');
    expect(parsed.totals.withProof).toBe(0);
  });

  it('rejects unknown and duplicate flags with usage exit 2', async () => {
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--results-dir', '/a', '--results-dir', '/b'])).code).toBe(2);
  });

  it('is routed from `fleet proof outcomes --help` and does not change verify/capture usage errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetProof(['outcomes', '--help'])).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('fleet.proof-outcomes.v1');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetProof(['bogus'])).toBe(2);
  });
});
