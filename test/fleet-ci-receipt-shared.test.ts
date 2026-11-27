import { describe, expect, it } from 'vitest';
import {
  artifactNameField,
  asRecord,
  assertRunnerResultOk,
  CI_RECEIPT_MAX_REASON,
  ciReceiptTargetKey,
  CiResumeInputsError,
  cleanCiReceiptReason,
  findSingleRunArtifactBearer,
  hasExactKeys,
  isNonNegativeInt,
  isPlainRecord,
  isPositiveId,
  isValidArtifactNameFlag,
  isValidCiReceiptIdentity,
  isValidCiReceiptTarget,
  isValidCiRepo,
  parseBoundedMsFlag,
  parseGhJsonOutput,
  parsePositiveIdFlag,
  parseRunArtifactRows,
  parseSlurpedPages,
  readBoundedUtf8Input,
  runGhApi,
} from '../src/core/fleet/ci-receipt-shared.js';
import type { GitRunResult } from '../src/core/verse/git-ops.js';

const okRun = (stdout: string): GitRunResult => ({
  code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false,
});

describe('ci-receipt-shared guards and identity helpers', () => {
  it('validates plain records, exact key sets and safe integers', () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord('x')).toBeNull();

    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);

    expect(isNonNegativeInt(0)).toBe(true);
    expect(isNonNegativeInt(-1)).toBe(false);
    expect(isNonNegativeInt(1.5)).toBe(false);
    expect(isPositiveId(1)).toBe(true);
    expect(isPositiveId(0)).toBe(false);
    expect(isPositiveId(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('validates GitHub owner/repo names, artifact names and exact target identities', () => {
    expect(isValidCiRepo('ashlrai/phantom')).toBe(true);
    expect(isValidCiRepo('ashlrai/phantom.js')).toBe(true);
    expect(isValidCiRepo('bad-/phantom')).toBe(false);
    expect(isValidCiRepo('bad--owner/phantom')).toBe(false);
    expect(isValidCiRepo('ashlrai/.')).toBe(false);
    expect(isValidCiRepo('ashlrai/..')).toBe(false);
    expect(isValidCiRepo('https://github.com/ashlrai/phantom')).toBe(false);

    expect(artifactNameField('ci-resume-receipts')).toBe('ci-resume-receipts');
    expect(artifactNameField('')).toBeNull();
    expect(artifactNameField('bad\nname')).toBeNull();
    expect(artifactNameField('a'.repeat(201))).toBeNull();

    expect(isValidArtifactNameFlag('ci-resume-receipts')).toBe(true);
    expect(isValidArtifactNameFlag('-leading-dash')).toBe(false);
    expect(isValidArtifactNameFlag('bad\x00name')).toBe(false);

    const target = { repo: 'AshlrAI/Phantom', run: 42, attempt: 2, artifactName: 'receipts' };
    expect(isValidCiReceiptIdentity(target)).toBe(true);
    expect(isValidCiReceiptTarget(target)).toBe(true);
    expect(isValidCiReceiptTarget({ ...target, extra: true })).toBe(false);
    expect(ciReceiptTargetKey(target)).toBe('ashlrai/phantom\u000042\u00002\u0000receipts');
  });

  it('sanitizes failure reasons by stripping VT/control bytes, scrubbing secrets and capping length', () => {
    const cleaned = cleanCiReceiptReason('\x1b[31mboom\x1b[0m\r\nline2\x07 Authorization: Bearer sample-value-1234567890');
    expect(cleaned).not.toContain('\x1b');
    expect(cleaned).not.toContain('\n');
    expect(cleaned).not.toContain('\x07');
    expect(cleaned).not.toContain('sample-value-1234567890');
    expect(cleanCiReceiptReason('x'.repeat(CI_RECEIPT_MAX_REASON + 50))).toHaveLength(CI_RECEIPT_MAX_REASON);
  });
});

describe('ci-receipt-shared runner and artifact evidence helpers', () => {
  it('checks runner failures and parses gh JSON output', async () => {
    expect(() => assertRunnerResultOk({ ...okRun(''), missing: true }, 'gh', 'meta')).toThrow('gh is not installed');
    expect(() => assertRunnerResultOk({ ...okRun(''), timedOut: true }, 'git', 'git ls-tree')).toThrow('git ls-tree timed out');
    expect(() => assertRunnerResultOk({ ...okRun(''), truncated: true }, 'gh', 'list')).toThrow('list output exceeded its bound');
    expect(() => assertRunnerResultOk({ ...okRun(''), code: 1, stderr: 'HTTP 404\nmore' }, 'gh', 'meta'))
      .toThrow('meta failed: HTTP 404');

    const res = await runGhApi(async () => okRun('{"ok":true}'), ['api', 'repos/a/b'], 1024, 'probe');
    expect(parseGhJsonOutput(res, 'probe')).toEqual({ ok: true });
    expect(() => parseGhJsonOutput(okRun('not-json'), 'probe')).toThrow('probe returned malformed JSON');
    await expect(runGhApi(async () => { throw new Error('spawn'); }, ['api'], 1024, 'probe'))
      .rejects.toThrow(CiResumeInputsError);
  });

  it('parses slurped pages, validates run artifact rows and resolves a single live bearer', () => {
    const pages = [
      { total_count: 2, artifacts: [{ id: 10, name: 'a', expired: false, workflow_run: { id: 99 } }] },
      { total_count: 2, artifacts: [{ id: 11, name: 'b', expired: false, workflow_run: null }] },
    ];
    expect(parseSlurpedPages(pages, 'artifacts', 'run artifacts')).toHaveLength(2);
    const rows = parseRunArtifactRows(pages);
    expect(rows).toEqual([
      { id: 10, name: 'a', expired: false, runId: 99 },
      { id: 11, name: 'b', expired: false, runId: null },
    ]);

    expect(findSingleRunArtifactBearer(rows, 99, 'a')).toEqual(rows[0]);
    expect(findSingleRunArtifactBearer(rows, 99, 'missing')).toBeNull();
    expect(() => findSingleRunArtifactBearer(rows, 100, 'a')).toThrow('does not belong to run 100');
    expect(() => findSingleRunArtifactBearer(
      [{ id: 10, name: 'a', expired: true, runId: 99 }], 99, 'a',
    )).toThrow('is expired');
    expect(() => findSingleRunArtifactBearer(
      [
        { id: 10, name: 'a', expired: false, runId: 99 },
        { id: 12, name: 'a', expired: true, runId: 99 },
      ], 99, 'a',
    )).toThrow('has 2 bearers in run 99');

    expect(() => parseSlurpedPages([], 'artifacts', 'run artifacts')).toThrow('malformed');
    expect(() => parseSlurpedPages(
      [{ total_count: 2, artifacts: [{ id: 10, name: 'a', expired: false }] }], 'artifacts', 'run artifacts',
    )).toThrow('pagination is ambiguous');
  });
});

describe('ci-receipt-shared CLI flag and bounded stdin helpers', () => {
  it('parses positive integer ids and bounded millisecond flags', () => {
    expect(parsePositiveIdFlag('42')).toBe(42);
    expect(parsePositiveIdFlag('0')).toBeNull();
    expect(parsePositiveIdFlag('-1')).toBeNull();
    expect(parsePositiveIdFlag('1e3')).toBeNull();
    expect(parsePositiveIdFlag(undefined)).toBeNull();

    expect(parseBoundedMsFlag('500', 1000)).toBe(500);
    expect(parseBoundedMsFlag('1001', 1000)).toBeNull();
    expect(parseBoundedMsFlag('0', 1000)).toBeNull();
    expect(parseBoundedMsFlag('abc', 1000)).toBeNull();
  });

  it('reads bounded UTF-8 streams and rejects TTY, oversize and invalid UTF-8 inputs', async () => {
    const stream = (chunks: Array<string | Uint8Array>): AsyncIterable<string | Uint8Array> => (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
    expect(await readBoundedUtf8Input(stream(['{"v":', Buffer.from('1}')]), 16)).toEqual({ ok: true, text: '{"v":1}' });
    expect(await readBoundedUtf8Input(stream(['12345']), 4)).toEqual({ ok: false, reason: 'input_too_large' });
    expect(await readBoundedUtf8Input(stream([new Uint8Array([0xff, 0xfe])]), 16))
      .toEqual({ ok: false, reason: 'input_unreadable' });

    const ttyStream = Object.assign(stream(['ok']), { isTTY: true });
    expect(await readBoundedUtf8Input(ttyStream, 16, true)).toEqual({ ok: false, reason: 'stdin_must_be_a_pipe' });
    expect(await readBoundedUtf8Input(ttyStream, 16, false)).toEqual({ ok: true, text: 'ok' });
  });
});
