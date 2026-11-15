import { expect, it } from 'vitest';
import { cutoverHeadline, readCutover } from './comms-cutover-model.js';

const cap = (state: string) => ({ state, reason: `r-${state}`, nextStep: 'phm fleet comms-readiness' });
const cutover = (state: string, capabilities: Record<string, unknown>) => ({ cutover: { overall: { state, blockers: [] }, capabilities } });

it('returns null when absent or malformed', () => {
  for (const bad of [undefined, null, {}, { cutover: null }, { cutover: { overall: {}, capabilities: [] } }, cutover('incomplete', {})])
    expect(readCutover(bad)).toBeNull();
});
it('keeps fixed label order and counts ready rows', () => {
  const view = readCutover(cutover('incomplete', { linkedin: cap('blocked'), emailPolling: cap('ready'), emailOutbox: cap('unsupported') }))!;
  expect(view.rows.map(r => r.label)).toEqual(['Email intake', 'Email reply outbox', 'LinkedIn']);
  expect(view.rows[1]!.stateWord).toBe('Not on this Mac');
  expect(cutoverHeadline(view)).toBe('Off Grok Bot: 1 of 8 ready');
});
it('says retirement is not proven when complete', () => {
  const view = readCutover(cutover('complete', { emailPolling: cap('ready') }))!;
  expect(cutoverHeadline(view)).toBe('Off Grok Bot: 1 of 8 ready · Commsbot retirement not proven locally');
  expect(cutoverHeadline(view)).not.toMatch(/done|retired/i);
});
it('drops unknown ids, unknown states and malformed rows', () => {
  const view = readCutover(cutover('incomplete', {
    emailPolling: cap('ready'), mystery: cap('ready'), linkedin: cap('great'), emailOutbox: { state: 'ready', reason: 1, nextStep: 'x' },
  }))!;
  expect(view.rows.map(r => r.id)).toEqual(['emailPolling']);
});
