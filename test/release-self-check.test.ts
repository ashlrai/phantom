import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classify, detectGui } from '../scripts/release-self-check.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

describe('release self-check', () => {
  it('skips with a reason when there is no GUI session', () => {
    expect(detectGui({ env: {}, platform: 'linux' })).toEqual({ available: false, reason: expect.stringMatching(/Headless Linux/) });
    expect(detectGui({ env: { DISPLAY: ':0' }, platform: 'linux' }).available).toBe(true);
    expect(detectGui({ env: {}, platform: 'darwin', macSession: () => 'Background' })).toEqual({ available: false, reason: expect.stringMatching(/Background, not Aqua/) });
    expect(detectGui({ env: {}, platform: 'darwin', macSession: () => 'Aqua' }).available).toBe(true);
    expect(detectGui({ env: { SESSIONNAME: 'Services' }, platform: 'win32' }).available).toBe(false);
    expect(detectGui({ env: { SESSIONNAME: 'Console' }, platform: 'win32' }).available).toBe(true);
    expect(detectGui({ env: { DISPLAY: ':0', PHM_SELF_CHECK_HEADLESS: '1' }, platform: 'linux' }).available).toBe(false);
  });

  it('treats a missing console or window as a skip and flagged screens as a failure', () => {
    expect(classify(JSON.stringify({ ok: false, verb: null, code: 'no_console', error: 'No running Phantom console.' }))).toMatchObject({ outcome: 'skip', reason: 'no_console: No running Phantom console.' });
    expect(classify(JSON.stringify({ ok: false, verb: 'navigate', code: 'no_client', error: 'Open the desktop app.' })).outcome).toBe('skip');
    expect(classify(JSON.stringify({ ok: false, verb: 'navigate', code: 'timeout', error: 'late' })).outcome).toBe('fail');
    const screen = (section: string, flags: string[]) => ({ section, ok: flags.length === 0, loadMs: 300, flags });
    expect(classify(JSON.stringify({ schema: 'phantom.self-check.v1', ok: true, screens: [screen('command', [])] }))).toMatchObject({ outcome: 'pass', lines: ['command: ok (300 ms)'] });
    expect(classify(JSON.stringify({ schema: 'phantom.self-check.v1', ok: false, screens: [screen('command', []), screen('chat', ['1 console error(s)'])] })))
      .toMatchObject({ outcome: 'fail', reason: '1 of 2 screens flagged.', lines: ['command: ok (300 ms)', 'chat: 1 console error(s) (300 ms)'] });
    expect(classify('not json').outcome).toBe('fail');
  });

  it('runs after the build, read-only, and gates every heavy step on a GUI', () => {
    const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/release-desktop.yml'), 'utf8')) as {
      jobs: Record<string, { needs?: string | string[]; permissions?: Record<string, string>; steps: { id?: string; if?: string; run?: string }[] }>;
    };
    const job = workflow.jobs['self-check']!;
    expect(job.needs).toBe('build');
    expect(job.permissions).toEqual({ contents: 'read' });
    const detect = job.steps.findIndex((s) => s.id === 'gui');
    expect(job.steps[detect]!.run).toBe('node scripts/release-self-check.mjs --detect');
    for (const step of job.steps.slice(detect + 1)) expect(step.if).toBe("steps.gui.outputs.available == 'true'");
    expect(job.steps.at(-1)!.run).toBe('node scripts/release-self-check.mjs --run');
    for (const [name, other] of Object.entries(workflow.jobs)) if (name !== 'self-check') expect([other.needs ?? []].flat()).not.toContain('self-check');
  });
});
