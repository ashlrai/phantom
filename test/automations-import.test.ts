import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAutomationsCli } from '../src/cli/automations.js';
import { listAutomations, nextOccurrence, parseRrule } from '../src/core/automations/index.js';
import { isolateAshlrHome } from './helpers/automations-fakes.js';

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const routine = (over: Record<string, unknown> = {}) => ({
  name: 'Morning check', schedule: '15 8 * * 1-5', timezone,
  prompt: 'Check the queue.\nReport any failures.', limits: [], ...over,
});

let restore: () => void;
beforeEach(() => { restore = isolateAshlrHome(); });
afterEach(() => restore());

async function run(input: unknown, flags: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const status = await runAutomationsCli(['import', '--from', 'routines.json', ...flags], {
    readFile: async () => JSON.stringify(input), out: (line) => out.push(line), err: (line) => err.push(line),
  });
  return { status, out: out.join('\n'), err: err.join('\n') };
}

describe('routine import', () => {
  it('converts cron, stores an unchanged prompt, and starts disabled', async () => {
    expect((await run([routine()])).status).toBe(0);
    const [saved] = await listAutomations();
    expect(saved?.enabled).toBe(false);
    expect(saved?.instructions).toBe(routine().prompt);
    expect(saved?.trigger.kind).toBe('schedule');
    if (!saved || saved.trigger.kind !== 'schedule') throw new Error('Expected schedule');
    const rule = parseRrule(saved.trigger.rrule);
    if (!rule.ok) throw new Error(rule.error);
    expect(nextOccurrence(rule.rule, new Date(2026, 10, 2, 8, 15))).toEqual(new Date(2026, 10, 3, 8, 15));
    expect(nextOccurrence(rule.rule, new Date(2026, 10, 6, 8, 15))).toEqual(new Date(2026, 10, 9, 8, 15));
  });

  it('accepts supported RRULEs and previews without writing', async () => {
    const result = await run([routine({ schedule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30' })], ['--dry-run', '--json']);
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.out)).not.toThrow();
    expect(await listAutomations()).toHaveLength(0);
  });

  it('deduplicates by name across imports', async () => {
    expect((await run([routine()])).status).toBe(0);
    expect((await run([routine()])).status).toBe(0);
    expect(await listAutomations()).toHaveLength(1);
  });

  it('rejects unsupported schedules without creating any entries', async () => {
    for (const schedule of ['0 8 1 2 *', '0 8 1 * 1', '@daily', '60 8 * * *']) {
      const result = await run([routine({ schedule })]);
      expect(result.status, schedule).not.toBe(0);
      expect(result.err.length, schedule).toBeGreaterThan(0);
    }
    expect(await listAutomations()).toHaveLength(0);
  });

  it('rejects a timezone the local scheduler cannot honor', async () => {
    const otherZone = timezone === 'Pacific/Honolulu' ? 'Asia/Tokyo' : 'Pacific/Honolulu';
    expect((await run([routine({ timezone: otherZone })])).status).not.toBe(0);
    expect(await listAutomations()).toHaveLength(0);
  });

  it('rejects secret-shaped prompts without disclosing them', async () => {
    const secret = 'gh' + 'p_' + 'a'.repeat(36);
    const result = await run([routine({ prompt: secret })]);
    expect(result.status).not.toBe(0);
    expect(result.out + result.err).not.toContain(secret);
    expect(await listAutomations()).toHaveLength(0);
  });

  it('rejects prompts that cannot survive existing normalization unchanged', async () => {
    const result = await run([routine({ prompt: ' leading whitespace' })]);
    expect(result.status).not.toBe(0);
    expect(await listAutomations()).toHaveLength(0);
  });

  it('validates the entire batch before writing', async () => {
    const result = await run([routine(), routine({ name: 'Invalid', schedule: 'not a schedule' })]);
    expect(result.status).not.toBe(0);
    expect(await listAutomations()).toHaveLength(0);
  });
});
