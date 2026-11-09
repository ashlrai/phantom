import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueRepeats, queueRepeats, type QueueLine } from '../src/cli/fleet-queue-repeats.js';
import { validQueueLines } from '../src/core/fleet/queue-repeats.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
const fixture = 'test/fixtures/queue-repeats/lines.json';
const now = Date.parse('2026-11-09T12:00:00Z');
afterEach(() => vi.restoreAllMocks());
it('catches the lexicon and plugin triples and passes unique, finished and stale lines', async () => {
  const lines = JSON.parse(await readFile(fixture, 'utf8')) as QueueLine[];
  const report = queueRepeats(lines, now);
  expect(report.repeats).toBe(4);
  expect(report.examples.map(e => e.id)).toEqual(['RQ-LEXICON9403', 'RQ-LEXICON9600', 'RQ-PLUGIN9505', 'RQ-PLUGIN9600']);
  expect(report.examples[0]!.group).toEqual(['RQ-LEXICON9300', 'RQ-LEXICON9403', 'RQ-LEXICON9600']);
  expect(report.examples[2]!.repeatOf).toBe('RQ-PLUGIN9201');
  expect(queueRepeats([...lines].reverse(), now)).toEqual(report);
  expect(queueRepeats(lines.filter(l => !/^RQ-(LEXICON|PLUGIN)/.test(l.id)), now).repeats).toBe(0);
});
it('shows at most five examples while counting every repeat', () => {
  const lines = Array.from({ length: 8 }, (_, i): QueueLine => ({ id: `RQ-${i}`, status: 'ready', repo: 'r', at: `2026-11-09T0${i}:00:00Z`, text: 'Fix a.ts. Acceptance: same.' }));
  const report = queueRepeats(lines, now);
  expect(report.repeats).toBe(7);
  expect(report.examples).toHaveLength(5);
  expect(validQueueLines([{ id: 1 }])).toBe(false);
});
it('offers plain and JSON output through the fleet registry', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetQueueRepeats(['--lines', fixture, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string).schema).toBe('fleet.queue-repeats.v1');
  expect(await cmdFleetQueueRepeats(['--help'])).toBe(0);
  expect(await cmdFleetQueueRepeats([])).toBe(2);
  expect(await cmdFleetQueueRepeats(['--lines', '/missing'])).toBe(1);
  expect(await cmdFleetQueueRepeats(['--lines', 'package.json'])).toBe(1);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['queue-repeats']!()).cmdFleetQueueRepeats).toBe('function');
});
