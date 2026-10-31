/**
 * RQ-PHX-JOBIDANCHOR31W8 — verify that isFleetJobId rejects trailing
 * newline / carriage-return characters.
 *
 * The JavaScript regex $ matches before a trailing newline, so
 * "RQ-FIXTURE\n" was accepted by the existing JOB_ID pattern.  This
 * suite proves the new guard rejects such inputs while all previously-
 * valid (clean) identifiers are still accepted.
 */

import { beforeEach, expect, describe, it } from 'vitest';
import { getFleetJobDetail, isFleetJobId } from '../../src/core/fleet/runs-job-detail.js';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'runs-job-end-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function runsDir(): Promise<string> {
  const dir = join(scratch, `runs-${Math.random().toString(36).slice(2)}`);
  return mkdir(dir, { recursive: true }).then(() =>
    writeFile(
      join(dir, 'RQ-FIXTURE-RUN.launch'),
      'launched RQ-FIXTURE-RUN devin pid 1 base abc1234\n',
    ).then(() =>
      writeFile(join(dir, 'RQ-FIXTURE-RUN.log'), 'log line\n').then(() => dir),
    ),
  );
}

// ---------------------------------------------------------------------------
// isFleetJobId — trailing-newline rejection (NEW)
// ---------------------------------------------------------------------------

describe('isFleetJobId — trailing newline rejection', () => {
  it('accepts valid minimum/maximum length IDs', () => {
    for (const ok of ['a_b', 'x'.repeat(80)]) {
      expect(isFleetJobId(ok)).toBe(true);
    }
  });

  it('rejects trailing LF', () => {
    expect(isFleetJobId('ab\n')).toBe(false);
    expect(isFleetJobId('RQ-PHX-JOBDETAIL\n')).toBe(false);
  });

  it('rejects trailing CRLF', () => {
    expect(isFleetJobId('ab\r\n')).toBe(false);
    expect(isFleetJobId('RQ-PHX-JOBDETAIL\r\n')).toBe(false);
  });

  it('rejects embedded control bytes', () => {
    expect(isFleetJobId('abc\x00')).toBe(false);
    expect(isFleetJobId('a\x01b\x02')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isFleetJobId('a/b')).toBe(false);
  });

  it('rejects dot-only prefix traversal shape', () => {
    expect(isFleetJobId('../')).toBe(false);
    expect(isFleetJobId('.dot')).toBe(false);
  });

  it('rejects Unicode IDs', () => {
    expect(isFleetJobId('日本語')).toBe(false);
    expect(isFleetJobId('Üñîcödé')).toBe(false);
  });

  it('rejects overlong IDs', () => {
    expect(isFleetJobId('x'.repeat(81))).toBe(false);
  });

  it('rejects short IDs (length < 3)', () => {
    expect(isFleetJobId('')).toBe(false);
    expect(isFleetJobId('ab')).toBe(false);
  });

  it('rejects leading hyphen or dot', () => {
    expect(isFleetJobId('-lead')).toBe(false);
    expect(isFleetJobId('.dot')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getFleetJobDetail rejects newline-suffixed IDs without source read
// ---------------------------------------------------------------------------

describe('getFleetJobDetail rejects newline-suffixed IDs without source read', () => {
  it('rejects a newline-suffixed ID before any fs access', async () => {
    const dir = await runsDir();
    await expect(
      getFleetJobDetail('RQ-FIXTURE-RUN\n', { runsDir: dir }),
    ).rejects.toThrow('invalid fleet job id');
  });
});
