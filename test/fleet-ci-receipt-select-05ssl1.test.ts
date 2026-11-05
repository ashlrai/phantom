import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiReceiptSelect } from '../src/cli/fleet-ci-receipt-select.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import {
  awaitCiReceiptBatch, type CiReceiptAwaitBatchTarget,
} from '../src/core/fleet/ci-receipt-await-batch.js';
import type { CiReceiptAwaitOptions } from '../src/core/fleet/ci-receipt-await.js';
import {
  CiResumeInputsError, parseCiResumePrior, type CiResumePrior,
} from '../src/core/fleet/ci-resume-inputs.js';
import type { CiResumeReceiptsFetch } from '../src/core/fleet/ci-resume-receipts.js';
import { CI_RECEIPT_SELECT_MAX_INPUT_BYTES } from '../src/core/fleet/ci-receipt-select.js';

const SHA = 'a'.repeat(40);
const [DIGEST_A, DIGEST_B, DIGEST_C] = ['1', '2', '3'].map((c) => `sha256:${c.repeat(64)}`);

type T = CiReceiptAwaitBatchTarget;
const TA: T = { repo: 'octo/fleet', run: 991, attempt: 2, artifactName: 'ci-resume-receipts' };
const TB: T = { repo: 'octo/fleet', run: 991, attempt: 3, artifactName: 'ci-resume-receipts' }; // attempt differs
const TC: T = { repo: 'octo/fleet', run: 991, attempt: 2, artifactName: 'ci-resume-receipts-extra' }; // name differs
const TD: T = { repo: 'octo/fleet', run: 992, attempt: 1, artifactName: 'ci-resume-receipts' }; // fails
const TE: T = { repo: 'octo/other', run: 55, attempt: 1, artifactName: 'ci-resume-receipts' }; // never reached
const TARGETS = [TA, TB, TC, TD, TE];
const key = (t: Pick<T, 'repo' | 'run' | 'attempt' | 'artifactName'>): string =>
  `${t.repo}\0${t.run}\0${t.attempt}\0${t.artifactName}`;
const prior = (t: T, digest: string): CiResumePrior => ({ version: 1, repo: t.repo,
  receipts: [{ job: 'lint', run: t.run, attempt: t.attempt, jobId: t.run + 1, headSha: SHA,
    conclusion: 'success', inputsDigest: digest }] });
const PRIORS = new Map([[key(TA), prior(TA, DIGEST_A)], [key(TB), prior(TB, DIGEST_B)], [key(TC), prior(TC, DIGEST_C)]]);

/** Real awaitCiReceiptBatch via its wait seam: three binds, TD fails and aborts, TE stays not-started. */
const realReport = async (): Promise<Record<string, any>> => {
  const controller = new AbortController();
  const wait = async (opts: CiReceiptAwaitOptions): Promise<CiResumeReceiptsFetch> => {
    const found = PRIORS.get(key(opts));
    if (found) return { prior: found, diagnostics: [`bound ${opts.repo} run ${opts.run}`] };
    if (key(opts) === key(TD)) { controller.abort(); throw new CiResumeInputsError('run 992 completed with no artifact named "ci-resume-receipts"'); }
    throw new CiResumeInputsError('unavailable');
  };
  const { report } = await awaitCiReceiptBatch(TARGETS,
    { timeoutMs: 60_000, pollMs: 250, signal: controller.signal }, { wait });
  return report as unknown as Record<string, any>;
};

/** Streamed stdin: the report arrives in bounded pieces, not one write. */
const streamIn = (doc: string | Buffer, pieces = 7): AsyncIterable<Uint8Array> => (async function* () {
  const buf = Buffer.isBuffer(doc) ? doc : Buffer.from(doc, 'utf8');
  const step = Math.max(1, Math.ceil(buf.length / pieces));
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
})();

let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
const cli = async (args: string[], input: AsyncIterable<Uint8Array> = streamIn('')) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptSelect(args, { input }), out: out.join('\n'), err: err.join('') };
};
const sel = (t: T): string[] => ['--stdin', '--repo', t.repo, '--run', String(t.run),
  '--attempt', String(t.attempt), '--artifact-name', t.artifactName, '--json'];

describe('fleet ci-receipt-select', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('ci-receipt-select')).toEqual(
      { module: './fleet-ci-receipt-select.js', exportName: 'cmdFleetCiReceiptSelect' });
    const { code, out: o } = await cli(['--help']);
    expect(code).toBe(0);
    for (const s of ['--stdin', '--repo', '--run', '--attempt', '--artifact-name',
      'ci-receipt-await-batch', '|', 'reuse', 'network']) expect(o).toContain(s);
  });

  it('selects exactly one bound entry from a real mixed report, digests verbatim', async () => {
    const report = await realReport();
    expect([report.bound, report.failed, report.notStarted]).toEqual([3, 1, 1]); // real mix
    const { code, out: o, err: e } = await cli(sel(TA), streamIn(JSON.stringify(report)));
    expect(code).toBe(0); expect(e).toBe('');
    const printed = JSON.parse(o);
    expect(parseCiResumePrior(printed)).toEqual(prior(TA, DIGEST_A)); // unchanged ci-resume-inputs prior
    expect(o).toContain(DIGEST_A); // producer digest bytes preserved
    expect(o).not.toContain(DIGEST_B); expect(o).not.toContain(DIGEST_C);
  });

  it('matches all four fields exactly — never position, a name substring or another attempt', async () => {
    const report = JSON.stringify(await realReport());
    const b = await cli(sel(TB), streamIn(report)); // same run+name, other attempt
    expect(b.code).toBe(0); expect(JSON.parse(b.out).receipts[0].inputsDigest).toBe(DIGEST_B);
    const c = await cli(sel(TC), streamIn(report)); // same repo+run+attempt; name holds A's as a prefix
    expect(c.code).toBe(0); expect(JSON.parse(c.out).receipts[0].inputsDigest).toBe(DIGEST_C);
    const misses = [{ ...TA, repo: 'octo/other' }, { ...TA, run: 992, attempt: 2 },
      { ...TA, attempt: 9 }, { ...TA, artifactName: 'ci-resume' }];
    for (const t of misses) { // one field off never selects
      const r = await cli(sel(t), streamIn(report));
      expect(r.code).toBe(1); expect(r.out).toBe('');
    }
  });

  it('fails closed on failed, not-started and missing identities with empty stdout', async () => {
    const report = JSON.stringify(await realReport());
    const d = await cli(sel(TD), streamIn(report));
    expect(d.code).toBe(1); expect(d.out).toBe(''); expect(d.err).toContain('no artifact');
    const e = await cli(sel(TE), streamIn(report));
    expect(e.code).toBe(1); expect(e.out).toBe(''); expect(e.err).toContain('not-started');
    const x = await cli(sel({ repo: 'octo/fleet', run: 1, attempt: 1, artifactName: 'x' }), streamIn(report));
    expect(x.code).toBe(1); expect(x.out).toBe(''); expect(x.err).toContain('no entry');
  });

  it('rejects malformed, inconsistent and oversized input before any output', async () => {
    const good = await realReport();
    const dup = structuredClone(good);
    dup.entries.push({ ...dup.entries[0] }); dup.total = 6; dup.bound = 4; // same exact identity twice
    const mismatched = structuredClone(good); mismatched.bound = 2;
    const short = structuredClone(good); short.entries.pop();
    const boundNoPrior = structuredClone(good); boundNoPrior.entries[0].prior = null;
    const failedWithPrior = structuredClone(good); failedWithPrior.entries[3].prior = prior(TD, DIGEST_A);
    const badRepo = structuredClone(good); badRepo.entries[0].repo = 'bad repo';
    const corruptBound = structuredClone(good);
    corruptBound.entries[0].prior = { version: 2, repo: 'octo/fleet', receipts: [] };
    const docs: (string | Buffer)[] = [
      'not json', '[]',
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify({ ...good, total: 17, entries: good.entries }),
      JSON.stringify(dup), JSON.stringify(mismatched), JSON.stringify(short),
      JSON.stringify(boundNoPrior), JSON.stringify(failedWithPrior), JSON.stringify(badRepo),
      Buffer.from('{"version":1,"total":', 'utf8'), // truncated document
      Buffer.concat([Buffer.from('{"version":1'), Buffer.from([0xff, 0xfd, 0x41]), Buffer.from(']}')]),
      Buffer.alloc(CI_RECEIPT_SELECT_MAX_INPUT_BYTES + 1, 0x20), // past the input bound
    ];
    for (const d of docs) {
      const r = await cli(sel(TA), streamIn(d, 3));
      expect(r.code).toBe(2); expect(r.out).toBe('');
    }
    const corrupt = await cli(sel(TA), streamIn(JSON.stringify(corruptBound)));
    expect(corrupt.code).toBe(2); expect(corrupt.out).toBe(''); // bound, but not a valid prior
  });

  it('rejects duplicate flags and bad arguments before reading stdin', async () => {
    const base = sel(TA);
    for (const args of [
      [...base, '--repo', 'octo/fleet'], [...base, '--stdin'], [...base, '--json'], // duplicates
      [...base, '--bogus'], [...base.slice(0, -1), '--run'], // unknown flag, dangling value
      sel({ ...TA, run: 0 }), sel({ ...TA, attempt: -1 }), sel({ ...TA, repo: 'bad repo' }),
      sel({ ...TA, artifactName: '' }), sel({ ...TA, artifactName: 'bad\nname' }),
      sel({ ...TA, artifactName: '-flag' }),
      ['--repo', 'octo/fleet', '--run', '1', '--attempt', '1', '--artifact-name', 'x', '--json'], // no --stdin
      ['--stdin', '--repo', 'octo/fleet'], // missing required flags
    ]) {
      const r = await cli(args, streamIn('{}'));
      expect(r.code).toBe(2); expect(r.out).toBe('');
    }
  });
});
