import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { briefLine, failureText, presetRows, saveOutcomeText, slateSummary } from './planner-slate-model.js';
import { narrowPlannerSlate, type PlannerSlateResult, type PlannerSlateView } from './planner-slate-queries.js';

const now = Date.parse('2026-11-01T00:08:00Z');
const view: PlannerSlateView = {
  v: 1, generatedAt: '2026-11-01T00:08:00Z', source: 'missing', path: 'queue/planner-candidates.json', candidates: [],
  promptPath: null, promptExists: false, promptAgeSeconds: null,
  presets: [{ id: 'codex-personal', provider: 'codex', available: true, binary: 'codex', dropDir: 'queue' },
    { id: 'claude', provider: 'claude', available: false, binary: null, dropDir: 'queue' }],
  briefCandidates: [{ path: 'queue/planner-brief.prompt', exists: true, ageSeconds: 240 }],
};
describe('planner slate model', () => {
  it('describes missing, invalid, empty and declared slates', () => {
    expect(slateSummary(view, now)).toEqual({ headline: 'No planner logins declared: the fleet cannot plan for itself', tone: 'warn' });
    expect(slateSummary({ ...view, source: 'invalid' }, now).tone).toBe('bad');
    expect(slateSummary({ ...view, source: 'ok' }, now).tone).toBe('warn');
    expect(slateSummary({ ...view, source: 'ok', candidates: [{ provider: 'codex', preset: 'codex-personal', argvLength: 1 }, { provider: 'claude', preset: null, argvLength: 0 }] }, now))
      .toEqual({ headline: 'Planner runs on codex-personal, claude', tone: 'ok' });
  });
  it('marks declared and unavailable presets', () => {
    const rows = presetRows({ ...view, source: 'ok', candidates: [{ provider: 'codex', preset: 'codex-personal', argvLength: 2 }] });
    expect(rows[0]).toMatchObject({ checked: true, enabled: true, note: null });
    expect(rows[1]).toMatchObject({ checked: false, enabled: false, note: 'claude not found on this Mac' });
    expect(presetRows({ ...view, source: 'invalid', candidates: [{ provider: 'codex', preset: 'codex-personal', argvLength: 1 }] })[0]?.checked).toBe(false);
  });
  it('describes brief candidates, declared briefs, unknown ages and missing files', () => {
    expect(briefLine(view, now)).toEqual({ text: 'Brief: queue/planner-brief.prompt, 4 min old', tone: 'ok' });
    expect(briefLine({ ...view, promptPath: 'queue/declared', promptExists: true, promptAgeSeconds: 10 }, now).text).toContain('less than a minute old');
    expect(briefLine({ ...view, promptPath: 'queue/declared', promptExists: true, promptAgeSeconds: null }, now).text).toContain('age unknown');
    expect(briefLine({ ...view, briefCandidates: [] }, now).tone).toBe('warn');
    expect(briefLine(view, now + 60_000).text).toContain('5 min old');
  });
  it('covers all save outcomes and failures', () => {
    const result: PlannerSlateResult = { v: 1, status: 'written', candidateCount: 1, promptPath: 'queue/brief' };
    expect(saveOutcomeText(result)).toBe('Planner logins saved.');
    expect(saveOutcomeText({ ...result, status: 'unchanged' })).toContain('already up to date');
    expect(saveOutcomeText({ ...result, status: 'refused' })).toContain('not saved');
    expect(failureText(new ApiError('', 409, '', 'preset-unavailable'))).toContain('unavailable');
    expect(failureText(new ApiError('', 409, '', 'no-brief'))).toContain('No brief');
    expect(failureText(new ApiError('', 404, ''))).toContain('unavailable');
    expect(failureText(new VerseControlLockedError())).toContain('Unlock actions');
    expect(failureText(new TypeError())).toBe('The server did not answer.');
  });
  it('rejects malformed contract data', () => {
    expect(narrowPlannerSlate(view)).toEqual(view);
    for (const bad of [null, {}, { ...view, source: 'other' }, { ...view, candidates: [{ provider: 'codex', preset: null, argvLength: -1 }] },
      { ...view, presets: [{}] }, { ...view, briefCandidates: [{}] }, { ...view, promptAgeSeconds: 'old' }]) expect(narrowPlannerSlate(bad)).toBeNull();
  });
});
