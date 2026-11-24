import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRouterDecision, readRouterDecisions } from '../src/core/providers/coding-cli/decision-reader.js';

const base = {
  ts: '2026-01-01T00:00:00.000Z', jobId: 'job-fake-1', jobType: 'coding', poolId: 'claude', consumer: null,
  policyId: 'policy-fake', canary: false, propensity: 0.5, solver: 'greedy', fallback: false,
  grantsMergeAuthority: false, netValue: 1.25, eligible: [{ poolId: 'claude', consumer: null }, { poolId: 'local', consumer: null }],
};
const line = (over: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...over });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmpFile = (content: string) => {
  const d = mkdtempSync(join(tmpdir(), 'rdr-646s-'));
  dirs.push(d);
  const f = join(d, 'decisions.jsonl');
  writeFileSync(f, content);
  return f;
};

describe('parseRouterDecision', () => {
  it('parses a valid source-format record', () => {
    expect(parseRouterDecision(line())).toEqual(base);
  });

  it('accepts explicit nulls for pool, consumer and netValue', () => {
    const row = parseRouterDecision(line({ poolId: null, consumer: null, netValue: null, eligible: [] }));
    expect(row).toMatchObject({ poolId: null, consumer: null, netValue: null, eligible: [] });
  });

  it('accepts a consumer on grok-ultra-weekly', () => {
    expect(parseRouterDecision(line({ poolId: 'grok-ultra-weekly', consumer: 'cloud-agent' }))?.consumer).toBe('cloud-agent');
  });

  it('rejects absent contract fields (undefined is not null)', () => {
    for (const key of Object.keys(base)) {
      const { [key]: _drop, ...rest } = base as Record<string, unknown>;
      expect(parseRouterDecision(JSON.stringify(rest)), key).toBeNull();
    }
  });

  it('rejects bad enums, empty jobId and bad solver', () => {
    expect(parseRouterDecision(line({ jobType: 'deploy' }))).toBeNull();
    expect(parseRouterDecision(line({ poolId: 'nope' }))).toBeNull();
    expect(parseRouterDecision(line({ consumer: 'nobody' }))).toBeNull();
    expect(parseRouterDecision(line({ jobId: '' }))).toBeNull();
    expect(parseRouterDecision(line({ solver: 'cplex' }))).toBeNull();
  });

  it('rejects nonfinite or negative numerics', () => {
    // JSON cannot encode NaN/Infinity; strings and nulls must not pass either.
    expect(parseRouterDecision(line({ propensity: '0.5' }))).toBeNull();
    expect(parseRouterDecision(line({ propensity: null }))).toBeNull();
    expect(parseRouterDecision(line({ propensity: -0.1 }))).toBeNull();
    expect(parseRouterDecision(line({ netValue: '1' }))).toBeNull();
    // 1e999 survives as text and JSON.parse turns it into Infinity.
    expect(parseRouterDecision(line({ propensity: 7 }).replace('"propensity":7', '"propensity":1e999'))).toBeNull();
    expect(parseRouterDecision(line({ netValue: 7 }).replace('"netValue":7', '"netValue":-1e999'))).toBeNull();
  });

  it('rejects any authority grant', () => {
    expect(parseRouterDecision(line({ grantsMergeAuthority: true }))).toBeNull();
    expect(parseRouterDecision(line({ grantsMergeAuthority: 'false' }))).toBeNull();
  });

  it('drops malformed eligible entries but keeps valid ones in order', () => {
    const row = parseRouterDecision(line({
      eligible: [{ poolId: 'devin', consumer: null }, null, 'x', { poolId: 'bogus', consumer: null },
        { poolId: 'local' }, { poolId: 'metered', consumer: 'bad' }, { poolId: 'grok-ultra-weekly', consumer: 'orchestrator' }],
    }));
    expect(row?.eligible).toEqual([{ poolId: 'devin', consumer: null }, { poolId: 'grok-ultra-weekly', consumer: 'orchestrator' }]);
  });

  it('rejects non-array eligible, non-objects and invalid JSON', () => {
    expect(parseRouterDecision(line({ eligible: 'claude' }))).toBeNull();
    expect(parseRouterDecision('[]')).toBeNull();
    expect(parseRouterDecision('null')).toBeNull();
    expect(parseRouterDecision('{not json')).toBeNull();
  });
});

describe('readRouterDecisions', () => {
  it('keeps file order, skips blank and malformed rows, and leaves bytes unchanged', () => {
    const content = [line({ jobId: 'a' }), '', '{bad', line({ jobId: 'b', grantsMergeAuthority: true }), `  ${line({ jobId: 'c' })}  `, line({ jobId: 'd', poolId: null })].join('\n');
    const file = tmpFile(content);
    const before = readFileSync(file);
    expect(readRouterDecisions(file).map((r) => r.jobId)).toEqual(['a', 'c', 'd']);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('returns [] for a missing file (not proof of inactivity)', () => {
    const file = tmpFile('');
    expect(readRouterDecisions(`${file}.absent`)).toEqual([]);
    expect(readRouterDecisions(file)).toEqual([]);
  });
});
