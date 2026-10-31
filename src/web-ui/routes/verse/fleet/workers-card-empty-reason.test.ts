import { expect, it } from 'vitest';
import { emptyReason, narrowWorkers } from './workers-card-model.js';

const snapshot = { v: 1, generatedAt: 'now', sources: { workers: 'healthy', runsDir: 'healthy' },
  workers: [], publishesLastHour: [], switches: [], paused: false };

it('narrows the new fields and falls back for missing or malformed values', () => {
  expect(narrowWorkers({ ...snapshot, switches: ['HOLD'], paused: true, sources: { ...snapshot.sources, runsDir: 'missing' } }))
    .toMatchObject({ switches: ['HOLD'], paused: true, runsDir: 'missing' });
  expect(narrowWorkers({ ...snapshot, switches: ['HOLD', 1], paused: 'yes', sources: { workers: 'healthy', runsDir: 1 } }))
    .toMatchObject({ switches: [], paused: null, runsDir: 'not-landed' });
  expect(narrowWorkers({ ...snapshot, switches: undefined, paused: undefined, sources: { workers: 'healthy' } }))
    .toMatchObject({ switches: [], paused: null, runsDir: 'not-landed' });
});

it('explains empty workers in priority order', () => {
  const data = narrowWorkers(snapshot)!;
  expect(emptyReason({ ...data, switches: ['HOLD'], paused: true, runsDir: 'missing' }))
    .toEqual({ text: 'Dispatch is paused by HOLD', tone: 'danger' });
  expect(emptyReason({ ...data, paused: true, runsDir: 'missing' }))
    .toEqual({ text: 'The dispatcher is paused', tone: 'warning' });
  expect(emptyReason({ ...data, runsDir: 'missing' }))
    .toEqual({ text: 'No fleet on this Mac yet (~/.ashlr-runs not found)', tone: 'neutral' });
  expect(emptyReason(data)).toEqual({ text: 'No workers running. Leaders write jobs every 15 minutes.', tone: 'neutral' });
});
