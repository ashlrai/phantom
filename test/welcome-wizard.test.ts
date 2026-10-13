import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWizard, markFirstRun, readFirstRun } from '../src/core/firstrun/wizard.js';
import { renderWizard } from '../src/cli/welcome.js';

const eco = (status: string) => ({ steps: ['github', 'workspace', 'enroll', 'doctor', 'grant', 'schedule', 'resident'].map((step) => ({ step, status, detail: '' })) }) as never;
const settings = (o: Record<string, unknown> = {}) => ({ autonomy: { level: 'propose', grantActive: false, maxLevel: 'propose' }, budget: { dailyUsd: 1 }, notifications: { desktop: false, proactive: false }, ...o }) as never;

describe('first-run wizard', () => {
  it('fresh machine: every step is todo and next is GitHub', () => {
    const w = buildWizard(eco('planned'), settings(), { finished: [], skipped: [] });
    expect(w.steps.map((s) => s.state)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
    expect(w.next?.command).toBe('gh auth login -h github.com -s repo,workflow');
    expect(renderWizard(w, false)).toContain('0/5 done');
  });
  it('derives done from real state and remembers finished/skipped', () => {
    const w = buildWizard(eco('already'), settings({ autonomy: { level: 'autonomous', grantActive: true, maxLevel: 'autonomous' }, notifications: { desktop: true, proactive: false } }), { finished: ['budget'], skipped: [] });
    expect(w.complete).toBe(true);
    const f = join(mkdtempSync(join(tmpdir(), 'fr-')), 'firstrun.json');
    markFirstRun('budget', 'skipped', f); markFirstRun('budget', 'skipped', f);
    expect(readFirstRun(f).skipped).toEqual(['budget']);
  });
});
