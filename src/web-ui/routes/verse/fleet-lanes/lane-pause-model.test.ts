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

it('falls back to the server-remembered target behind the local record', () => {
  expect(resumeTransition('codex', {}, 0, 6)).toEqual({ target: 6, record: {} });
  expect(resumeTransition('codex', { codex: 4 }, 0, 6).target).toBe(4);
  expect(resumeTransition('codex', {}, 2, 2).target).toBe(2);
  expect(resumeTransition('codex', {}, 2, 1).target).toBe(2);
  expect(pauseLabel('codex', {}, 6)).toBe('Paused · was 6');
  expect(pauseLabel('codex', { codex: 4 }, 6)).toBe('Paused · was 4');
  expect(pauseLabel('codex', {})).toBeNull();
});

it('ignores corrupt storage and invalid values', () => {
  expect(parsePauseRecord('{')).toEqual({});
  expect(parsePauseRecord('[]')).toEqual({});
  expect(parsePauseRecord('{"zero":0,"bad":"3","fraction":1.5,"ok":24}')).toEqual({ ok: 24 });
});
