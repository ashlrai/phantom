import { describe, expect, it } from 'vitest';
import type { MainHealthRepo } from '../shell/main-health-query.js';
import { draftBytes, validateDraft } from './drop-job-model.js';
import { mainRedFixDraft } from './main-red-fix-draft.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

function redRepo(over: Partial<MainHealthRepo> = {}): MainHealthRepo {
  return {
    repo: 'phantom', branch: 'master', sha: SHA, state: 'red',
    checkedAt: '2026-11-02T11:00:00Z', failingCheck: 'build', fixJobs: [], nightlyRed: null,
    ...over,
  };
}

describe('mainRedFixDraft', () => {
  it('passes validateDraft and names repo, branch, sha7 and the failing check', () => {
    const draft = mainRedFixDraft(redRepo(), NOW)!;
    expect(validateDraft(draft)).toMatchObject({ ok: true });
    expect(draft.id).toBe('MAINFIXABCDEF0');
    expect(draft.lane).toBe('codex-personal');
    expect(draft.tier).toBe('mid');
    expect(draft.body).toContain('phantom');
    expect(draft.body).toContain('master');
    expect(draft.body).toContain('abcdef0');
    expect(draft.body).toContain('build');
    expect(draft.body).toContain('guardian.log');
    expect(draft.body).not.toContain('nightlyRed');
  });

  it('names nightlyRed only when present', () => {
    expect(mainRedFixDraft(redRepo({ nightlyRed: 'web smoke' }), NOW)!.body).toContain('nightlyRed=web smoke');
    expect(mainRedFixDraft(redRepo(), NOW)!.body).not.toContain('nightlyRed=');
  });

  it('stays under 7000 bytes and validates with fields longer than 200 chars', () => {
    const long = 'x'.repeat(400);
    const draft = mainRedFixDraft(redRepo({ branch: long, failingCheck: long, nightlyRed: long }), NOW)!;
    expect(new TextEncoder().encode(draft.body).length).toBeLessThanOrEqual(7000);
    expect(draftBytes(draft)).toBeLessThanOrEqual(8000);
    expect(validateDraft(draft)).toMatchObject({ ok: true });
    expect(draft.body).not.toContain(long);
  });

  it('strips control characters from every field', () => {
    const draft = mainRedFixDraft(redRepo({
      branch: 'fake\x00branch', failingCheck: 'build\nrm -rf /', nightlyRed: 'nightly\x07red',
    }), NOW)!;
    expect(draft.body).not.toContain('\x00');
    expect(draft.body).not.toContain('\x07');
    expect(draft.body).toContain('fake branch');
    expect(draft.body).toContain('build rm -rf /');
    expect(draft.body).toContain('nightly red');
  });

  it('still produces a valid draft when sha is null', () => {
    const draft = mainRedFixDraft(redRepo({ sha: null }), NOW)!;
    expect(validateDraft(draft)).toMatchObject({ ok: true });
    expect(draft.id).toMatch(/^[A-Z0-9]{3,40}$/);
    expect(draft.body).toContain('sha=unknown');
  });

  it('is deterministic — same input gives the same id, different sha a different id', () => {
    expect(mainRedFixDraft(redRepo(), NOW)!.id).toBe(mainRedFixDraft(redRepo(), NOW)!.id);
    expect(mainRedFixDraft(redRepo({ sha: null }), NOW)!.id).toBe(mainRedFixDraft(redRepo({ sha: null }), NOW)!.id);
    expect(mainRedFixDraft(redRepo({ sha: `1111111${'0'.repeat(33)}` }), NOW)!.id).toBe('MAINFIX1111111');
  });
});
