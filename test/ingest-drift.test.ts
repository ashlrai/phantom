/** Hermetic: fixture ingest files live in a temp dir; nothing reads ~/.ashlr-runs. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIngestDrift, compareIngestSource } from '../src/core/fleet/ingest-drift.js';
import { checkIngestDriftDoctor } from '../src/core/doctor.js';
import { INGEST_JOB_HEADER, INGEST_JOB_ID } from '../src/core/fleet/drop-job-contract.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const fixture = (text: string) => {
  const d = mkdtempSync(join(tmpdir(), 'ingest-drift-')); dirs.push(d);
  const path = join(d, 'orch-ingest.py'); writeFileSync(path, text); return path;
};
const ingest = (over: { head?: string; id?: string; lanes?: string } = {}) => [
  'import re',
  `HEAD = re.compile(r'${over.head ?? INGEST_JOB_HEADER.source}')`,
  `ID = re.compile(r"${over.id ?? INGEST_JOB_ID.source}")`,
  `LANES = (${over.lanes ?? "'devin', 'claude', 'codex-local', 'codex-personal'"})`,
  '',
].join('\n');

describe('ingest drift', () => {
  it('matches a fixture copied from the contract (lane order ignored)', () => {
    const r = checkIngestDrift(fixture(ingest()));
    expect(r.verdict).toBe('match');
    expect(r.fields.every((f) => f.same)).toBe(true);
    expect(checkIngestDriftDoctor(() => r)).toMatchObject({ id: 'ingest-drift', status: 'pass', detail: 'match' });
  });

  it.each([
    ['HEAD', { head: INGEST_JOB_HEADER.source.replace('|locus', '') }],
    ['ID', { id: '^RQ-PHX-[A-Z0-9]{3,60}$' }],
    ['LANES', { lanes: "'claude', 'devin'" }],
  ])('names the drifted field %s', (field, over) => {
    const r = checkIngestDrift(fixture(ingest(over)));
    expect(r.verdict).toBe(`drift: ${field}`);
    expect(checkIngestDriftDoctor(() => r)).toMatchObject({ status: 'warn', detail: `drift: ${field}` });
  });

  it('is unknown, and not a failure, when the file is missing', () => {
    const r = checkIngestDrift(join(tmpdir(), 'no-such-dir-ingest-drift', 'orch-ingest.py'));
    expect(r.verdict).toBe('unknown: orch-ingest.py not found');
    expect(checkIngestDriftDoctor(() => r)).toMatchObject({ status: 'pass', detail: r.verdict });
  });

  it('is unknown when a pattern is not found, and says which', () => {
    const r = compareIngestSource("import re\nLANES = ('claude',)\n");
    expect(r.verdict).toBe('unknown: HEAD, ID not found in orch-ingest.py');
    expect(checkIngestDriftDoctor(() => r).status).toBe('warn');
  });

  it('never throws out of the doctor check', () => {
    expect(checkIngestDriftDoctor(() => { throw new Error('x'); })).toMatchObject({ status: 'warn', detail: 'unknown: could not compare' });
  });
});
