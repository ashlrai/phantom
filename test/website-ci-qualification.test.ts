import { describe, expect, it } from 'vitest';
import { touchesWorkflows, websiteChecksQualify } from '../src/core/website/host-adapter.js';
import { WEBSITE_PROFILE } from '../src/core/website/host-release.js';

const ACTIONS = '15368'; const FLEET = '5089472';
const run = (id: number, name: string, appId: string, conclusion: string | null = 'success', status = 'completed') => ({ id, name, appId, status, conclusion });
const ci = [{ context: 'Lint', appId: ACTIONS }, { context: 'Test (ubuntu-latest)', appId: ACTIONS }];
const req = [...ci, { context: 'ashlr/verify', appId: FLEET }];
const greenCi = [run(1, 'Lint', ACTIONS), run(2, 'Test (ubuntu-latest)', ACTIONS)];
const greenAll = [...greenCi, run(3, 'ashlr/verify', FLEET)];
const now = Date.now();
const site = ['apps/web/app/page.tsx'];

describe('website source qualification checks', () => {
  it('pins ashlr/verify from the fleet App in WEBSITE_PROFILE', () => {
    expect(WEBSITE_PROFILE.requiredChecks).toContainEqual({ context: 'ashlr/verify', appId: FLEET });
  });
  it('accepts the normal website path when all required checks and ashlr/verify are green', () => {
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: greenAll, statuses: [] }, now, site)).toBe(true);
  });
  it('rejects a ruleset that does not require ashlr/verify, even with green CI', () => {
    expect(websiteChecksQualify({ strict: true, required: ci }, { runs: greenCi, statuses: [] }, now, site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: ci }, { runs: greenAll, statuses: [] }, now, site)).toBe(false);
  });
  it('rejects the website profile when ashlr/verify is not green', () => {
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: greenCi, statuses: [] }, now, site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [...greenCi, run(3, 'ashlr/verify', FLEET, 'failure')], statuses: [] }, now, site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [...greenCi, run(3, 'ashlr/verify', '42')], statuses: [] }, now, site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: [...ci, { context: 'ashlr/verify', appId: '42' }] }, { runs: [...greenCi, run(3, 'ashlr/verify', '42')], statuses: [] }, now, site)).toBe(false);
  });
  it('rejects a workflow-touching head unless ashlr/verify is green', () => {
    const wf = ['.github/workflows/ci.yml', 'apps/web/app/page.tsx'];
    expect(touchesWorkflows(wf)).toBe(true);
    expect(touchesWorkflows(site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: ci }, { runs: greenCi, statuses: [] }, now, wf)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: greenCi, statuses: [] }, now, wf)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [...greenCi, run(3, 'ashlr/verify', FLEET, null, 'in_progress')], statuses: [] }, now, wf)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: greenAll, statuses: [] }, now, wf)).toBe(true);
  });
  it('treats unknown head paths as workflow-touching', () => {
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: greenCi, statuses: [] }, now, null)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: greenAll, statuses: [] }, now, null)).toBe(true);
  });
  it('rejects a failing or pending required check', () => {
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [greenAll[0]!, run(2, 'Test (ubuntu-latest)', ACTIONS, 'failure'), greenAll[2]!], statuses: [] }, now, site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [greenAll[0]!, run(2, 'Test (ubuntu-latest)', ACTIONS, null, 'in_progress'), greenAll[2]!], statuses: [] }, now, site)).toBe(false);
  });
  it('rejects a same-named check from the wrong App', () => {
    expect(websiteChecksQualify({ strict: true, required: req }, { runs: [run(1, 'Lint', '999'), greenAll[1]!, greenAll[2]!], statuses: [] }, now, site)).toBe(false);
  });
  it('rejects non-strict, unavailable or empty rule sets', () => {
    expect(websiteChecksQualify({ strict: false, required: req }, { runs: greenAll, statuses: [] }, now, site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, rulesetsUnavailable: true, required: req }, { runs: greenAll, statuses: [] }, now, site)).toBe(false);
    expect(websiteChecksQualify({ strict: true, required: [] }, { runs: [], statuses: [] }, now, site)).toBe(false);
  });
});
