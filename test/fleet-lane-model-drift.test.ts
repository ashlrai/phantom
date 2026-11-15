/** fleet-lane-model-drift.test.ts — pure tests of classifyLaneModel and
 * laneModelDrift against a small inline fake catalog, so the assertions do
 * not depend on which real models KNOWN_MODELS currently lists. */
import { expect, it } from 'vitest';
import {
  classifyLaneModel, laneModelDrift,
  type DriftCatalogEntry,
} from '../src/core/fleet/lane-model-drift.js';
import type { LaneModelLane, LaneModelSnapshot } from '../src/core/fleet/lane-models.js';

const CATALOG: readonly DriftCatalogEntry[] = [
  { id: 'claude:fake-opus-9', apiModelId: 'fake-opus-9-api' },
  { id: 'codex:fake-old-1', historical: true },
];

it('classifies id, tag, apiModelId and case spellings', () => {
  expect(classifyLaneModel('claude:fake-opus-9', CATALOG)).toBe('known'); // full id
  expect(classifyLaneModel('fake-opus-9', CATALOG)).toBe('known'); // tag after ':'
  expect(classifyLaneModel('fake-opus-9-api', CATALOG)).toBe('known'); // apiModelId
  expect(classifyLaneModel('CLAUDE:FAKE-OPUS-9', CATALOG)).toBe('known'); // case-insensitive
  expect(classifyLaneModel('  Fake-Opus-9  ', CATALOG)).toBe('known'); // trims
});

it('accepts a trailing [1m]-style context tag and codex effort suffixes', () => {
  expect(classifyLaneModel('fake-opus-9[1m]', CATALOG)).toBe('known');
  expect(classifyLaneModel('fake-opus-9[256k]', CATALOG)).toBe('known');
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    expect(classifyLaneModel(`fake-opus-9-${effort}`, CATALOG), effort).toBe('known');
  }
  expect(classifyLaneModel('fake-opus-9-xhigh[1m]', CATALOG)).toBe('known'); // both, either order
  expect(classifyLaneModel('fake-opus-9[1m]-high', CATALOG)).toBe('known');
  expect(classifyLaneModel('fake-opus-9[1M]-XHIGH', CATALOG)).toBe('known'); // case-insensitive
});

it('flags retired ids historical and everything else unknown', () => {
  expect(classifyLaneModel('codex:fake-old-1', CATALOG)).toBe('historical');
  expect(classifyLaneModel('fake-old-1', CATALOG)).toBe('historical');
  expect(classifyLaneModel('fake-old-1-max', CATALOG)).toBe('historical'); // effort still applies
  expect(classifyLaneModel('fake-opus-99', CATALOG)).toBe('unknown'); // typo
  expect(classifyLaneModel('codex:fake-opus-9', CATALOG)).toBe('unknown'); // right tag, wrong engine prefix
  expect(classifyLaneModel('fake-opus-9-extreme', CATALOG)).toBe('unknown'); // not an effort suffix
  expect(classifyLaneModel('', CATALOG)).toBe('unknown');
});

it('known wins when a spelling hits both a current and a historical entry', () => {
  const both: readonly DriftCatalogEntry[] = [
    { id: 'codex:fake-shared-1', historical: true },
    { id: 'claude:fake-shared-1' },
  ];
  expect(classifyLaneModel('fake-shared-1', both)).toBe('known');
});

const lane = (id: string, cells: { tier: string; model: string | null; via?: string | null }[]): LaneModelLane => ({
  lane: id, family: id, lastLaunch: null, mismatch: false,
  tiers: cells.map(c => ({ tier: c.tier, model: c.model, via: c.via === undefined ? (c.model === null ? null : id) : c.via })),
});
const snapshot = (lanes: LaneModelLane[], sources?: LaneModelSnapshot['sources']): LaneModelSnapshot => ({
  schema: 'fleet.lane-models.v1', generatedAt: '2026-11-04T20:00:00Z',
  tiers: ['frontier', 'work', 'mid', 'fast', 'low'], lanes,
  sources: sources ?? {
    models: { state: 'healthy', file: 'models.json', entries: 3 },
    launches: { state: 'missing', file: 'metrics/jobs.jsonl', launches: 0, dropped: 0 },
  },
});

it('emits one row per distinct model per lane and counts by status', () => {
  const report = laneModelDrift(snapshot([
    lane('claude-main', [
      { tier: 'frontier', model: 'fake-opus-9', via: 'claude-main.frontier' },
      { tier: 'work', model: 'fake-opus-9', via: 'claude-main' }, // same model again — deduped
      { tier: 'mid', model: 'fake-opus-9' },
      { tier: 'fast', model: 'fake-old-1', via: 'claude-main.fast' },
      { tier: 'low', model: 'gpt-6.1-terrra', via: 'claude-main.low' }, // typo → unknown
    ]),
    lane('idle-lane', [{ tier: 'work', model: null }, { tier: 'fast', model: null }]), // unresolved cells skipped
  ]), CATALOG);
  expect(report.schema).toBe('fleet.lane-model-drift.v1');
  expect(report.generatedAt).toBe('2026-11-04T20:00:00Z');
  expect(report.rows).toEqual([
    { lane: 'claude-main', tier: 'frontier', model: 'fake-opus-9', via: 'claude-main.frontier', status: 'known' },
    { lane: 'claude-main', tier: 'fast', model: 'fake-old-1', via: 'claude-main.fast', status: 'historical' },
    { lane: 'claude-main', tier: 'low', model: 'gpt-6.1-terrra', via: 'claude-main.low', status: 'unknown' },
  ]);
  expect(report.counts).toEqual({ known: 1, historical: 1, unknown: 1 });
});

it('keeps the first resolving tier and via for a deduped model', () => {
  const report = laneModelDrift(snapshot([
    lane('codex', [
      { tier: 'work', model: 'fake-opus-9', via: 'codex' },
      { tier: 'mid', model: 'fake-opus-9', via: 'codex' },
    ]),
  ]), CATALOG);
  expect(report.rows).toEqual([
    { lane: 'codex', tier: 'work', model: 'fake-opus-9', via: 'codex', status: 'known' },
  ]);
});

it('passes source states through unchanged, including missing and degraded', () => {
  const degraded = snapshot([], {
    models: { state: 'degraded', file: 'models.json', entries: 2 },
    launches: { state: 'missing', file: 'metrics/jobs.jsonl', launches: 0, dropped: 0 },
  });
  const report = laneModelDrift(degraded, CATALOG);
  expect(report.rows).toEqual([]);
  expect(report.counts).toEqual({ known: 0, historical: 0, unknown: 0 });
  expect(report.sources).toEqual(degraded.sources);
});
