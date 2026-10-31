import { describe, expect, it } from 'vitest';
import { clampStep, FLEET_STEP_POINTS, ONBOARDING_STEPS } from './onboarding-model.js';

describe('fleet onboarding step', () => {
  it('sits between autonomy and stops and keeps stored steps in bounds', () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      'welcome', 'accounts', 'local', 'autonomy', 'fleet', 'stops', 'finish',
    ]);
    expect(ONBOARDING_STEPS[4]?.title).toBe('Your fleet');
    expect(clampStep(-1)).toBe(0);
    expect(clampStep(6)).toBe(6);
    expect(clampStep(100)).toBe(6);
    expect(clampStep(Number.NaN)).toBe(0);
  });

  it('names the fleet surfaces and only the intended paths', () => {
    expect(FLEET_STEP_POINTS.map((point) => point.label)).toEqual([
      'Fleet workspace', "Leaders' inbox", 'Kill switches',
    ]);
    const text = FLEET_STEP_POINTS.map((point) => `${point.label} ${point.detail}`).join(' ');
    expect(text.match(/(?:~\/|\/)[\w./-]+|\b[\w-]+\.md\b/g)).toEqual(['~/.ashlr-runs', 'MASON-INBOX.md']);
    expect(text).toMatch(/live jobs, lanes and merges/);
    expect(text).toMatch(/prompts and interjections.*leaders read every pass/);
    expect(text).toMatch(/HOLD, PAUSE.*Fleet ▸ Switches.*stop dispatch/);
  });
});
