/**
 * Coverage for src/core/ci-fix-filter.ts — the allowlist validation and
 * filter-config logic behind `phm daily-fix` (RQ-DAILYFIX-REDISPATCH-PHANTOM).
 * Pure functions only: no network, no gh, no HOME.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_JOBS,
  INFRA_JOBS,
  ONLY_JOBS_REGEX,
  ONLY_TESTS_REGEX,
  activeJobs,
  aggregateFixupLines,
  buildDispatchCommand,
  buildFilterConfig,
  parseFixupLine,
  parseOnlyJobs,
  shouldRunJob,
  validateDispatchInputs,
  vitestFilterArgs,
} from '../src/core/ci-fix-filter.js';

describe('validateDispatchInputs — allowlist (fail closed)', () => {
  it('accepts empty and undefined inputs', () => {
    expect(() => validateDispatchInputs({})).not.toThrow();
    expect(() => validateDispatchInputs({ onlyJobs: '', onlyTests: '' })).not.toThrow();
  });

  it('accepts every allowlisted job, comma-separated with spaces', () => {
    const value = ALLOWED_JOBS.join(', ');
    expect(ONLY_JOBS_REGEX.test(value)).toBe(true);
    expect(() => validateDispatchInputs({ onlyJobs: value })).not.toThrow();
  });

  it('rejects job names outside the allowlist', () => {
    for (const bad of ['merge-gate', 'secret-shape', 'ci;rm -rf /', 'CI', 'ci,bogus', 'fixup-queue']) {
      expect(ONLY_JOBS_REGEX.test(bad), bad).toBe(false);
      expect(() => validateDispatchInputs({ onlyJobs: bad })).toThrow(/only_jobs/);
    }
  });

  it('rejects quotes, backticks, control chars and non-ASCII test filters', () => {
    // The allowlist is printable ASCII for env-var transport; quotes and
    // backticks are the characters that could break out of a vitest -t arg.
    for (const bad of ['foo"id"', "foo'id'", 'foo`id`', 'foo\nid', 'föö', 'foo\tid']) {
      expect(ONLY_TESTS_REGEX.test(bad), JSON.stringify(bad)).toBe(false);
      expect(() => validateDispatchInputs({ onlyTests: bad })).toThrow(/only_tests/);
    }
    // Punctuation that is safe inside an env var passes through untouched.
    for (const ok of ['foo;id', 'foo$(id)', 'foo|id', 'a/b.test.ts -t x']) {
      expect(ONLY_TESTS_REGEX.test(ok), ok).toBe(true);
    }
    expect(() => validateDispatchInputs({ onlyTests: 'a'.repeat(513) })).toThrow(/512/);
    expect(() => validateDispatchInputs({ onlyTests: 'a'.repeat(512) })).not.toThrow();
  });

  it('accepts printable test patterns and shard values', () => {
    expect(() => validateDispatchInputs({ onlyTests: 'resource engineering (m310)' })).not.toThrow();
    for (const shard of ['all', '0', '3', '6']) {
      expect(() => validateDispatchInputs({ macShard: shard })).not.toThrow();
    }
    for (const shard of ['7', '-1', 'two', 'all,0']) {
      expect(() => validateDispatchInputs({ macShard: shard })).toThrow(/mac_shard/);
    }
  });
});

describe('filter config', () => {
  it('empty onlyJobs selects all allowed jobs', () => {
    const config = buildFilterConfig({});
    expect(config.jobs).toEqual(ALLOWED_JOBS);
    expect(config.testFilter).toBeUndefined();
    expect(config.macShard).toBeUndefined();
  });

  it('parseOnlyJobs trims and drops empties', () => {
    expect(parseOnlyJobs(' ci , mac-general ,, ')).toEqual(['ci', 'mac-general']);
    expect(parseOnlyJobs(undefined)).toEqual([]);
    expect(parseOnlyJobs('   ')).toEqual([]);
  });

  it('shouldRunJob always runs infra jobs, gates test jobs on selection', () => {
    const config = buildFilterConfig({ onlyJobs: 'ci' });
    for (const infra of INFRA_JOBS) expect(shouldRunJob(infra, config)).toBe(true);
    expect(shouldRunJob('ci', config)).toBe(true);
    expect(shouldRunJob('mac-general', config)).toBe(false);
    expect(shouldRunJob('not-a-job', config)).toBe(false);
  });

  it('activeJobs is infra plus selected test jobs', () => {
    expect(activeJobs(buildFilterConfig({ onlyJobs: 'ci,docs' })))
      .toEqual([...INFRA_JOBS, 'ci', 'docs']);
  });

  it('vitestFilterArgs emits -t only when a filter exists', () => {
    expect(vitestFilterArgs(buildFilterConfig({}))).toEqual([]);
    expect(vitestFilterArgs(buildFilterConfig({ onlyTests: 'hop' }))).toEqual(['-t', 'hop']);
  });
});

describe('buildDispatchCommand', () => {
  it('emits a gh workflow run command with -f inputs', () => {
    expect(buildDispatchCommand({ onlyJobs: 'ci', onlyTests: 'hop', macShard: '2', ref: 'master' }))
      .toBe('gh workflow run ci.yml -f only_jobs=ci -f only_tests=hop -f mac_shard=2 -r master');
    expect(buildDispatchCommand({})).toBe('gh workflow run ci.yml');
  });
});

describe('fixup line parsing', () => {
  it('extracts job and mac_shard from READY fixup lines', () => {
    const line = '- READY RQ-FIXUP-PHANTOM-abc123-1 (lane=work job=mac-general result=FAILED mac_shard=2/4)';
    expect(parseFixupLine(line)).toEqual({ job: 'mac-general', macShard: '2' });
    expect(parseFixupLine('- READY x job=ci mac_shard=all done')).toEqual({ job: 'ci', macShard: 'all' });
    expect(parseFixupLine('no job token here')).toBeNull();
  });

  it('aggregates unique jobs and keeps the shard', () => {
    const inputs = aggregateFixupLines([
      'noise line',
      '- READY a job=ci result=X mac_shard=3',
      '- READY b job=docs result=Y',
      '- READY c job=ci result=Z mac_shard=all',
    ]);
    expect(inputs.onlyJobs).toBe('ci,docs');
    expect(inputs.macShard).toBe('all');
  });
});
