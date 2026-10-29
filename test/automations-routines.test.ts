import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAutomationsCli } from '../src/cli/automations.js';
import {
  automationTemplate, listAutomations, nextOccurrence, parseRrule,
  readAutomationState, runAutomationsTick,
} from '../src/core/automations/index.js';
import { fakeClock, fakeGh, fakeLanes, isolateAshlrHome } from './helpers/automations-fakes.js';

const routines = [
  { id: 'nightly-drain', hour: 2, day: 27, nextDay: 28 },
  { id: 'morning-summary', hour: 8, day: 27, nextDay: 28 },
  { id: 'weekly-review', hour: 9, day: 28, nextDay: 5 },
];
let restore: () => void;
beforeEach(() => { restore = isolateAshlrHome(); });
afterEach(() => restore());

describe('routine templates', () => {
  it('lists the routines in human and JSON CLI output without creating automations', async () => {
    const lines: string[] = [];
    const deps = { out: (line: string) => lines.push(line) };
    expect(await runAutomationsCli(['templates'], deps)).toBe(0);
    for (const { id } of routines) expect(lines.join('\n')).toContain(id);
    lines.length = 0;
    expect(await runAutomationsCli(['templates', '--json'], deps)).toBe(0);
    const result = JSON.parse(lines[0]!) as { templates: { id: string }[] };
    for (const { id } of routines) expect(result.templates.map((t) => t.id)).toContain(id);
    expect(await listAutomations()).toEqual([]);
  });

  it.each(routines)('$id creates a bounded disabled routine and recurs in local time', async ({ id, hour, day, nextDay }) => {
    const template = automationTemplate(id)!;
    expect(template.input).toMatchObject({
      enabled: false, lane: 'fleet', playbookId: id === 'nightly-drain' ? 'fix-issue' : 'docs-sync', repos: ['*'],
      spendCapUsd: 0, maxConcurrent: 1, maxPerDay: 20, queueDepth: 20,
      dedupeKey: null, triage: null,
    });
    if (id !== 'nightly-drain') {
      const { getPlaybook } = await import('../src/core/playbooks/index.js');
      const playbook = await getPlaybook(template.input.playbookId!);
      expect(playbook!.sections.Outcome).toContain('the report is the documentation outcome');
      expect(playbook!.sections.Outcome).toContain('do not edit files');
      expect(template.input.instructions).toContain('read-only report mode');
    }
    expect(template.input.trigger.kind).toBe('schedule');
    if (template.input.trigger.kind !== 'schedule') throw new Error('Expected schedule');
    const parsed = parseRrule(template.input.trigger.rrule);
    if (!parsed.ok) throw new Error(parsed.error);
    const first = new Date(2026, 8, day, hour);
    const next = new Date(2026, id === 'weekly-review' ? 9 : 8, nextDay, hour);
    expect(nextOccurrence(parsed.rule, new Date(first.getTime() - 1))).toEqual(first);
    expect(nextOccurrence(parsed.rule, first)).toEqual(next);

    expect(await runAutomationsCli(['add', '--template', id, '--repos', 'acme/app'], { out: () => {} })).toBe(0);
    const [saved] = await listAutomations();
    expect(saved).toMatchObject({ enabled: false, repos: ['acme/app'], trigger: template.input.trigger });
    const clock = fakeClock(new Date(first.getTime() - 60_000));
    const lanes = fakeLanes();
    const github = fakeGh(() => ({ fail: 'Schedules must not poll GitHub' }));
    const deps = { ...lanes.deps, gh: github.gh, now: clock.now, decider: null };
    await runAutomationsTick(deps);
    expect((await readAutomationState()).firings).toEqual([]);
    expect(await runAutomationsCli(['enable', saved!.id], { out: () => {} })).toBe(0);
    await runAutomationsTick(deps);
    expect(lanes.fleetCalls).toHaveLength(0);
    clock.set(first);
    await runAutomationsTick(deps);
    expect(lanes.fleetCalls).toHaveLength(1);
    expect(lanes.fleetCalls[0]).toMatchObject({ repo: 'acme/app' });
    expect(JSON.stringify(lanes.fleetCalls[0])).toContain(template.input.instructions);
    await runAutomationsTick(deps);
    expect(lanes.fleetCalls).toHaveLength(1);
    expect((await readAutomationState()).cursors[saved!.id]!.nextRunAt).toBe(next.toISOString());
    expect(github.calls).toEqual([]);
    expect(lanes.cloudCalls).toEqual([]);
    expect(lanes.devinCalls).toEqual([]);
  });
});
