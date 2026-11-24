/**
 * Contract: whatever the drop-job writer accepts, the host ingest accepts.
 * The ingest patterns are fixtures (copied from orch-ingest.py); nothing here
 * reads ~/.ashlr-runs. Hermetic: temp runs dir only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  DROP_JOB_LANES, DROP_JOB_REPOS, DROP_JOB_TIERS, composeDropJobFile, explainDropJobReasons, validateDropJob, writeDropJob,
} from '../src/core/fleet/drop-job-writer.js';

const INGEST_ID = /^RQ-PHX-[A-Z0-9]{3,40}$/;
const INGEST_FILE = /^RQ-PHX-.*\.md$/;
const INGEST_HEADER = /^#job repo=(phantom|phantom-secrets|ashlr-plugin|ashlr-stack|locus|lexicon|ashlr-md) lane=(\S+) tier=(\S+)\s*$/;
const INGEST_LANES = ['claude', 'codex-personal', 'devin', 'codex-local'];
const INGEST_TIERS = ['frontier', 'work', 'mid', 'fast'];

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const root = () => { const d = mkdtempSync(join(tmpdir(), 'drop-contract-')); dirs.push(d); return d; };
const job = (over: Record<string, unknown> = {}) => ({ id: 'GAPONE', repo: 'phantom', lane: 'claude', tier: 'work', body: 'Do the thing.', ...over });
const reasonsOf = (v: ReturnType<typeof validateDropJob>) => (v.ok ? [] : v.reasons);

describe('drop-job writer matches the ingest contract', () => {
  it('lists exactly the ingest repos, lanes and tiers', () => {
    expect([...DROP_JOB_REPOS]).toEqual(['phantom', 'phantom-secrets', 'ashlr-plugin', 'ashlr-stack', 'locus', 'lexicon', 'ashlr-md']);
    expect([...DROP_JOB_LANES]).toEqual(INGEST_LANES);
    expect([...DROP_JOB_TIERS]).toEqual(INGEST_TIERS);
  });

  it.each(['phantom', 'locus'])('writes a valid %s job the ingest accepts', async (repo) => {
    const r = root();
    const written = await writeDropJob(r, job({ repo }));
    const text = readFileSync(written.file, 'utf8');
    const first = text.split('\n')[0]!;
    expect(INGEST_HEADER.exec(first)?.[1]).toBe(repo);
    expect(INGEST_FILE.test(basename(written.file))).toBe(true);
    expect(INGEST_ID.test(basename(written.file, '.md'))).toBe(true);
  });

  it('rejects a bad id with plain words', () => {
    const v = validateDropJob(job({ id: 'gap one' }));
    expect(reasonsOf(v)).toContain('id-shape');
    expect(explainDropJobReasons(reasonsOf(v))).toMatch(/^refused: the job id must be/);
  });

  it('rejects an over-long id (41 characters) and accepts 40', () => {
    expect(reasonsOf(validateDropJob(job({ id: 'A'.repeat(41) })))).toContain('id-shape');
    expect(validateDropJob(job({ id: 'A'.repeat(40) })).ok).toBe(true);
  });

  it('rejects a bad lane and a bad tier', () => {
    expect(reasonsOf(validateDropJob(job({ lane: 'sol' })))).toContain('lane');
    expect(reasonsOf(validateDropJob(job({ tier: 'huge' })))).toContain('tier');
    expect(explainDropJobReasons(['lane'])).toContain('claude, codex-personal, devin, codex-local');
  });

  it('rejects a repo the ingest does not know', () => {
    expect(reasonsOf(validateDropJob(job({ repo: 'elsewhere' })))).toContain('repo');
  });

  it('never accepts a job whose header the ingest would reject', () => {
    for (const repo of [...DROP_JOB_REPOS, 'nope', 'phantom lane=devin']) {
      for (const lane of [...INGEST_LANES, 'sol', 'a b']) {
        for (const tier of [...INGEST_TIERS, 'x', 'a b']) {
          const input = job({ repo, lane, tier });
          if (!validateDropJob(input).ok) continue;
          const header = composeDropJobFile(input as Parameters<typeof composeDropJobFile>[0]).split('\n')[0]!;
          const m = INGEST_HEADER.exec(header);
          expect(m, header).not.toBeNull();
          expect(INGEST_LANES).toContain(m![2]);
          expect(INGEST_TIERS).toContain(m![3]);
        }
      }
    }
  });
});
