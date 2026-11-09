/**
 * Radar automation template: it uses the existing `schedule` trigger, names a
 * built-in read-only playbook, passes the strict definition validator, and
 * refuses any schedule that fires less than six hours apart. The radar source
 * catalogue must keep the required Grok and Cursor sources and never list
 * Stacksync (excluded by Mason's Nov 4 2026 amendment).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTOMATION_TEMPLATES, automationTemplate, parseRrule } from '../src/core/automations/index.js';
import { assertRadarSchedule, AutomationInputError, normaliseAutomation, RADAR_MIN_INTERVAL_MINUTES } from '../src/core/automations/validate.js';
import { getPlaybook } from '../src/core/playbooks/index.js';
import { isolateAshlrHome } from './helpers/automations-fakes.js';

const now = new Date(2026, 10, 9, 8, 0);

describe('radar automation template', () => {
  let restore: () => void;
  beforeEach(() => { restore = isolateAshlrHome(); });
  afterEach(() => restore());

  it('is registered once, disabled, on the schedule trigger, with a read-only playbook', async () => {
    const template = automationTemplate('radar-docs-sweep');
    expect(template).not.toBeNull();
    expect(AUTOMATION_TEMPLATES.filter((t) => t.id === 'radar-docs-sweep')).toHaveLength(1);
    const input = template!.input;
    expect(input.enabled).toBe(false);
    expect(input.trigger.kind).toBe('schedule');
    expect(input.playbookId).toBe('docs-sync');
    expect(await getPlaybook('docs-sync')).not.toBeNull();
    expect(input.instructions).toMatch(/read-only/);
    expect(input.instructions).toMatch(/phm radar run --json/);
    expect(input.instructions).toMatch(/grok-bot-changelog and grok-build-changelog first/);
  });

  it('passes the strict definition validator and a six-hour floor', () => {
    const input = automationTemplate('radar-docs-sweep')!.input;
    const automation = normaliseAutomation({ ...input }, { now });
    expect(automation.id).toBe('au_radar-docs-and-tool-changes');
    expect(automation.trigger).toEqual({ kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0' });
    expect(() => assertRadarSchedule(input.trigger.kind === 'schedule' ? input.trigger.rrule : '', now)).not.toThrow();
  });

  it('refuses intervals under six hours', () => {
    for (const rrule of [
      'FREQ=HOURLY',
      'FREQ=HOURLY;INTERVAL=1',
      'FREQ=HOURLY;INTERVAL=5',
      'FREQ=HOURLY;BYMINUTE=0,30',
      'FREQ=HOURLY;BYHOUR=0,3,6,9',
      'FREQ=DAILY;BYHOUR=0,3',
    ]) {
      expect(() => assertRadarSchedule(rrule, now), rrule).toThrow(AutomationInputError);
    }
    expect(() => assertRadarSchedule('FREQ=HOURLY;INTERVAL=5', now)).toThrow(/at most every 6 hours/);
  });

  it('accepts schedules at least six hours apart, including sparse ones', () => {
    for (const rrule of [
      'FREQ=HOURLY;INTERVAL=6',
      'FREQ=HOURLY;BYHOUR=0,6,12,18;BYMINUTE=0',
      'FREQ=DAILY;BYHOUR=7;BYMINUTE=0',
      'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9',
      'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=7',
    ]) {
      expect(() => assertRadarSchedule(rrule, now), rrule).not.toThrow();
    }
    expect(RADAR_MIN_INTERVAL_MINUTES).toBe(360);
  });

  it('reports unparseable rules as input errors', () => {
    expect(() => assertRadarSchedule('FREQ=YEARLY', now)).toThrow(AutomationInputError);
    expect(parseRrule('FREQ=YEARLY').ok).toBe(false);
  });
});

describe('radar source catalogue (Nov 4 2026 amendment)', () => {
  const sources = JSON.parse(readFileSync(new URL('../radar/sources.json', import.meta.url), 'utf8')) as Array<{ id: string; url: string }>;

  it('excludes Stacksync everywhere in the catalogue', () => {
    expect(JSON.stringify(sources).toLowerCase()).not.toContain('stacksync');
  });

  it('keeps the required Grok and Cursor sources', () => {
    const urls = new Set(sources.map((s) => s.url));
    for (const url of [
      'https://x.ai/changelog/bot/rss.xml',
      'https://x.ai/changelog/build/rss.xml',
      'https://cursor.com/changelog',
      'https://cursor.com/docs/cli/changelog',
      'https://cursor.com/docs/release-notes/cloud-agents',
    ]) {
      expect(urls.has(url), url).toBe(true);
    }
  });
});
