import { describe, expect, it } from 'vitest';
import { MAX_FIX_GENERATIONS, nextFixGeneration } from '../src/core/fleet/ci-fix-generations.js';

const BASE = 'RQ-CIFLAKE-0123456789ABCDEF';
const row = (status: string, id: string, body = 'stabilize the flaky test') =>
  `- ${status} ${id} (P1, repo=repo, tier=work, needs=git|gh|node): ${body}\n`;

describe('nextFixGeneration', () => {
  it('returns generation 1 when the family is absent', () => {
    expect(nextFixGeneration('', BASE)).toEqual({ jobId: BASE, generation: 1 });
    expect(nextFixGeneration('- READY RQ-OTHER-1 (P1, repo=repo, tier=work): unrelated\n', BASE))
      .toEqual({ jobId: BASE, generation: 1 });
  });

  it('suppresses queueing while any family row is open', () => {
    for (const status of ['READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'PROPOSED', 'SPLIT-PARENT', 'FIXUP', 'LAND']) {
      expect(nextFixGeneration(row(status, BASE), BASE), status).toBeNull();
    }
  });

  it('re-queues as -G2 when every prior generation reached DONE', () => {
    expect(nextFixGeneration(row('DONE', BASE), BASE)).toEqual({ jobId: `${BASE}-G2`, generation: 2 });
    const two = row('DONE', BASE) + row('DONE', `${BASE}-G2`);
    expect(nextFixGeneration(two, BASE)).toEqual({ jobId: `${BASE}-G3`, generation: 3 });
  });

  it('suppresses retry after the generation cap', () => {
    const text = [1, 2, 3].map(g => row('DONE', g === 1 ? BASE : `${BASE}-G${g}`)).join('');
    expect(nextFixGeneration(text, BASE)).toBeNull();
    expect(MAX_FIX_GENERATIONS).toBe(3);
  });

  it('honors a custom generation cap', () => {
    const text = row('DONE', BASE) + row('DONE', `${BASE}-G2`);
    expect(nextFixGeneration(text, BASE, { maxGenerations: 2 })).toBeNull();
    expect(nextFixGeneration(text, BASE, { maxGenerations: 3 })).toEqual({ jobId: `${BASE}-G3`, generation: 3 });
    expect(() => nextFixGeneration('', BASE, { maxGenerations: 0 })).toThrow(RangeError);
    expect(() => nextFixGeneration('', BASE, { maxGenerations: 1.5 })).toThrow(RangeError);
  });

  it('keeps dropped, retired and mixed-terminal rows suppressed', () => {
    expect(nextFixGeneration(row('DROPPED', BASE), BASE)).toBeNull();
    expect(nextFixGeneration(row('RETIRED', BASE), BASE)).toBeNull();
    expect(nextFixGeneration(row('DONE', BASE) + row('DROPPED', `${BASE}-G2`), BASE)).toBeNull();
    expect(nextFixGeneration(row('DONE', BASE) + row('RETIRED', `${BASE}-G2`), BASE)).toBeNull();
  });

  it('suppresses on open rows even beside DONE generations', () => {
    const text = row('DONE', BASE) + row('CLAIMED', `${BASE}-G2`);
    expect(nextFixGeneration(text, BASE)).toBeNull();
  });

  it('suppresses when an unparsed job-shaped line mentions the base id', () => {
    const malformed = `- READY ${BASE} (P1, repo=repo, tier=work, needs=!!!): invalid needs\n`;
    expect(nextFixGeneration(malformed, BASE)).toBeNull();
    const superseded = `- SUPERSEDED-BY-RQ-OTHER-9 ${BASE} (P1): replaced\n`;
    expect(nextFixGeneration(superseded, BASE)).toBeNull();
  });

  it('ignores the base id inside another job body but not its own row', () => {
    const other = `- READY RQ-OTHER-2 (P1, repo=repo, tier=work): see also ${BASE} for context\n`;
    expect(nextFixGeneration(other, BASE)).toEqual({ jobId: BASE, generation: 1 });
    const own = row('DONE', BASE, `references ${BASE}-G9 in prose`);
    expect(nextFixGeneration(own, BASE)).toEqual({ jobId: `${BASE}-G2`, generation: 2 });
  });

  it('does not treat lookalike ids as family members', () => {
    const text = row('READY', `${BASE}X`) + row('READY', `${BASE}-G0`) + row('READY', `${BASE}-G2-extra`);
    expect(nextFixGeneration(text, BASE)).toEqual({ jobId: BASE, generation: 1 });
    const cousin = 'RQ-CIFLAKE-0123456789ABCDE0';
    expect(nextFixGeneration(row('DONE', cousin), BASE)).toEqual({ jobId: BASE, generation: 1 });
  });

  it('treats a non-queue file as generation 1 unless the id appears verbatim', () => {
    expect(nextFixGeneration('not a queue at all\n', BASE)).toEqual({ jobId: BASE, generation: 1 });
    expect(nextFixGeneration(`plain text mentioning ${BASE}\n`, BASE)).toBeNull();
  });
});
