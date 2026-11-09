import { assertMetadata } from '../connectors/profile.js';
import { createAutomation } from './index.js';
import { parseRrule } from './rrule.js';
import { readAutomations } from './store.js';
import { AUTOMATION_LIMITS, type AutomationV1 } from './types.js';
import { AutomationInputError, normaliseAutomation } from './validate.js';

const fail = (message: string): never => { throw new AutomationInputError(message); };

function field(raw: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!match) return fail('Unsupported cron field. Use numeric values, lists, ranges, or steps.');
    const base = match[1]!;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const bounds = base === '*' ? [min, max] : base.split('-').map(Number);
    const start = bounds[0]!;
    const end = bounds[1] ?? start;
    if (!Number.isSafeInteger(step) || step < 1 || start < min || end > max || start > end || (bounds.length === 1 && match[2] !== undefined)) {
      return fail('Unsupported or out-of-range cron field.');
    }
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return [...values].sort((a, b) => a - b);
}

/** Convert only cron expressions representable without changing their calendar semantics. */
export function cronToRrule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fail('Cron must have five fields: minute hour day-of-month month day-of-week.');
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  if (month !== '*') return fail('Cron month restrictions are not supported.');
  if (day !== '*' && weekday !== '*') return fail('Cron cannot restrict both day-of-month and day-of-week.');
  const minutes = field(minute, 0, 59);
  const hours = field(hour, 0, 23);
  const days = field(day, 1, 31);
  const weekdays = field(weekday, 0, 7).map((n) => n === 7 ? 0 : n);
  const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const freq = day !== '*' ? 'MONTHLY' : weekday !== '*' ? 'WEEKLY' : 'DAILY';
  const rule = [`FREQ=${freq}`, `BYHOUR=${hours.join(',')}`, `BYMINUTE=${minutes.join(',')}`];
  if (day !== '*') rule.push(`BYMONTHDAY=${days.join(',')}`);
  if (weekday !== '*') rule.push(`BYDAY=${[...new Set(weekdays)].map((n) => codes[n]).join(',')}`);
  return rule.join(';');
}

export async function importRoutines(raw: unknown, dryRun = false): Promise<{ imported: AutomationV1[]; skipped: string[]; dryRun: boolean }> {
  try { assertMetadata(JSON.stringify(raw)); } catch { return fail('Secret-shaped routine data refused. Use a vault reference instead.'); }
  if (!Array.isArray(raw)) return fail('Routines must be a JSON array.');
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const candidates: AutomationV1[] = [];
  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`Routine ${index + 1} must be an object.`);
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => !['name', 'schedule', 'timezone', 'prompt', 'limits'].includes(key))) return fail(`Routine ${index + 1} has an unknown field.`);
    if (typeof item['timezone'] !== 'string') return fail(`Routine ${index + 1} needs a timezone.`);
    let zone: string;
    try { zone = new Intl.DateTimeFormat('en', { timeZone: item['timezone'] }).resolvedOptions().timeZone; }
    catch { return fail(`Routine ${index + 1} has an invalid timezone.`); }
    if (zone !== localZone) return fail(`Routine ${index + 1} timezone must match the machine local timezone (${localZone}).`);
    if (!Array.isArray(item['limits']) || item['limits'].length !== 0) return fail(`Routine ${index + 1} limits must be an empty array; other limits cannot be mapped safely.`);
    if (typeof item['schedule'] !== 'string' || typeof item['prompt'] !== 'string') return fail(`Routine ${index + 1} needs schedule and prompt text.`);
    const schedule = item['schedule'];
    const rrule = /^(?:RRULE:)?FREQ=/i.test(schedule.trim()) ? schedule : cronToRrule(schedule);
    const parsed = parseRrule(rrule);
    if (!parsed.ok) return fail(`Routine ${index + 1} schedule: ${parsed.error}`);
    const candidate = normaliseAutomation({ name: item['name'], instructions: item['prompt'], enabled: false, lane: 'fleet', repos: ['*'], spendCapUsd: 0, trigger: { kind: 'schedule', rrule } }, { now: new Date() });
    if (candidate.instructions !== item['prompt']) return fail(`Routine ${index + 1} prompt cannot be stored unchanged (maximum ${AUTOMATION_LIMITS.instructionsMaxChars} characters, no unsupported whitespace or control characters).`);
    candidates.push(candidate);
  }
  const stored = await readAutomations();
  if (stored.invalid) return fail('Existing automations contain invalid entries; repair the store before importing.');
  const names = new Set(stored.automations.map((a) => a.name));
  const skipped: string[] = [];
  const pending: AutomationV1[] = [];
  for (const candidate of candidates) {
    if (names.has(candidate.name)) { skipped.push(candidate.name); continue; }
    names.add(candidate.name);
    pending.push(candidate);
  }
  if (stored.automations.length + pending.length > AUTOMATION_LIMITS.maxAutomations) return fail(`At most ${AUTOMATION_LIMITS.maxAutomations} automations.`);
  const imported: AutomationV1[] = [];
  for (const candidate of pending) {
    if (dryRun) imported.push(candidate);
    else {
      const { v: _v, id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = candidate;
      imported.push(await createAutomation(input));
    }
  }
  return { imported, skipped, dryRun };
}
