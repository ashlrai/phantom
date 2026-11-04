/**
 * Unit contract for core/fleet/job-header.ts — the pure validator for the
 * `#job` first-line header ingest demands. Pure function: no fs, no HOME.
 */
import { describe, expect, it } from 'vitest';
import { parseJobHeader } from '../src/core/fleet/job-header.js';

describe('parseJobHeader', () => {
  it('accepts a valid header', () => {
    expect(parseJobHeader('#job repo=phantom lane=devin tier=work'))
      .toEqual({ ok: true, repo: 'phantom', lane: 'devin', tier: 'work' });
  });

  it('rejects an unknown tier', () => {
    const result = parseJobHeader('#job repo=phantom lane=devin tier=turbo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/tier/);
  });

  it('rejects an extra space', () => {
    expect(parseJobHeader('#job  repo=phantom lane=devin tier=work').ok).toBe(false);
    expect(parseJobHeader('#job repo=phantom  lane=devin tier=work').ok).toBe(false);
    expect(parseJobHeader('#job repo=phantom lane=devin tier=work ').ok).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(parseJobHeader('#job repo=phantom lane=devin').ok).toBe(false);
    expect(parseJobHeader('#job repo=phantom tier=work').ok).toBe(false);
    expect(parseJobHeader('#job lane=devin tier=work').ok).toBe(false);
  });

  it('rejects a bad file name for repo=phantom', () => {
    expect(parseJobHeader('#job repo=phantom lane=devin tier=work', 'drop-job.md').ok).toBe(false);
    expect(parseJobHeader('#job repo=phantom lane=devin tier=work', 'RQ-PHX-lower.md').ok).toBe(false);
    expect(parseJobHeader('#job repo=phantom lane=devin tier=work', 'RQ-PHX-AB.md').ok).toBe(false);
  });

  it('accepts a good file name for repo=phantom', () => {
    expect(parseJobHeader('#job repo=phantom lane=devin tier=work', 'RQ-PHX-JOBHEADERPARSE05.md'))
      .toEqual({ ok: true, repo: 'phantom', lane: 'devin', tier: 'work' });
  });
});
