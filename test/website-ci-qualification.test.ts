import { describe, expect, it } from 'vitest';
import { websiteChecksQualify } from '../src/core/website/host-adapter.js';

const ACTIONS = '15368'; const FLEET = '5089472';
const run = (id: number, name: string, appId: string, conclusion: string | null = 'success', status = 'completed') => ({ id, name, appId, status, conclusion });
const ci = [{ context: 'Lint', appId: ACTIONS }, { context: 'Test (ubuntu-latest)', appId: ACTIONS }];
const greenCi = [run(1, 'Lint', ACTIONS), run(2, 'Test (ubuntu-latest)', ACTIONS)];

describe('website source qualification checks', () => {
  it('accepts all-green required CI when ashlr/verify is not required', () => {
    expect(websiteChecksQualify({ strict: true, required: ci }, { runs: greenCi, statuses: [] })).toBe(true);
  });
  it('rejects a failing or pending required check', () => {
    expect(websiteChecksQualify({ strict: true, required: ci }, { runs: [greenCi[0]!, run(2, 'Test (ubuntu-latest)', ACTIONS, 'failure')], statuses: [] })).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: ci }, { runs: [greenCi[0]!, run(2, 'Test (ubuntu-latest)', ACTIONS, null, 'in_progress')], statuses: [] })).toBe(false);
  });
  it('rejects a same-named check from the wrong App', () => {
    expect(websiteChecksQualify({ strict: true, required: ci }, { runs: [run(1, 'Lint', '999'), greenCi[1]!], statuses: [] })).toBe(false);
  });
  it('rejects non-strict, unavailable or empty rule sets', () => {
    expect(websiteChecksQualify({ strict: false, required: ci }, { runs: greenCi, statuses: [] })).toBe(false);
    expect(websiteChecksQualify({ strict: true, rulesetsUnavailable: true, required: ci }, { runs: greenCi, statuses: [] })).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: [] }, { runs: [], statuses: [] })).toBe(false);
  });
  it('still accepts and pins ashlr/verify when the ruleset requires it', () => {
    const req = [...ci, { context: 'ashlr/verify', appId: FLEET }];
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [...greenCi, run(3, 'ashlr/verify', FLEET)], statuses: [] })).toBe(true);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: greenCi, statuses: [] })).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [...greenCi, run(3, 'ashlr/verify', '42')], statuses: [] })).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: [...ci, { context: 'ashlr/verify', appId: '42' }] }, { runs: [...greenCi, run(3, 'ashlr/verify', '42')], statuses: [] })).toBe(false);
  });
});
