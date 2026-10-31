import { expect, it } from 'vitest';
import { parsePauseRecord, pauseLabel, pauseTransition, resumeTransition } from './lane-pause-model.js';

it('remembers a target when pausing and removes it when resuming', () => {
  const paused = pauseTransition('codex-personal', 24, { devin: 3 });
  expect(paused).toEqual({ target: 0, record: { devin: 3, 'codex-personal': 24 } });
  expect(pauseLabel('codex-personal', paused.record)).toBe('Paused · was 24');
  expect(resumeTransition('codex-personal', paused.record)).toEqual({ target: 24, record: { devin: 3 } });
  expect(pauseLabel('missing', paused.record)).toBeNull();
});

it('never remembers zero and falls back to the floor or one', () => {
  expect(pauseTransition('codex', 0, {})).toEqual({ target: 0, record: {} });
  expect(pauseTransition('codex', 0, { codex: 24 }).record).toEqual({ codex: 24 });
  expect(resumeTransition('codex', {}, 2).target).toBe(2);
  expect(resumeTransition('codex', {}, 0).target).toBe(1);
});

it('ignores corrupt storage and invalid values', () => {
  expect(parsePauseRecord('{')).toEqual({});
  expect(parsePauseRecord('[]')).toEqual({});
  expect(parsePauseRecord('{"zero":0,"bad":"3","fraction":1.5,"ok":24}')).toEqual({ ok: 24 });
});
