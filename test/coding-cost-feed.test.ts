import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { buildCodingCostFeed, parseCodingCostRecord } from '../src/core/observability/coding-cost-feed.js';

const fixture: unknown[] = JSON.parse(readFileSync(new URL('./fixtures/router/coding-cost-events.json', import.meta.url), 'utf8'));
const spend = fixture[0] as Record<string, unknown>;
const merge = fixture[3] as Record<string, unknown>;

describe('coding cost feed', () => {
  it('rolls up retry spend by task class and merged PR with coverage', () => {
    const feed = buildCodingCostFeed(fixture);
    expect(feed.byTaskClass).toHaveLength(2);
    expect(feed.byTaskClass.find(r => r.taskClass === 'bugfix')).toMatchObject({
      tasks: 1, spendRecords: 2, tokensIn: 150, tokensOut: 50, costUsd: 0.35,
      missingCost: 0, estimatedCostRecords: 1,
    });
    expect(feed.byTaskClass.find(r => r.taskClass === 'docs')).toMatchObject({
      missingCost: 1, missingTokensIn: 1, missingTokensOut: 1, costUsd: 0,
    });
    expect(feed.byMergedPr).toHaveLength(1);
    expect(feed.byMergedPr[0]).toMatchObject({ repo: 'ashlrai/phantom', prNumber: 42, missingTasks: [] });
    expect(feed.byMergedPr[0]!.totals).toMatchObject({ spendRecords: 2, costUsd: 0.35, tokensIn: 150, tokensOut: 50 });
    expect(feed.byMergedPr[0]!.groups).toEqual(feed.byTaskClass.filter(r => r.taskClass === 'bugfix'));
    expect(feed.posthogEvents.map(r => r.event)).toEqual([
      'coding_spend_recorded', 'coding_spend_recorded', 'coding_spend_recorded',
      'coding_merged_pr_spend', 'coding_merged_pr_spend',
    ]);
  });

  it('is deterministic across ordering and replay, including JSON key order', () => {
    const reordered = Object.fromEntries(Object.entries(spend).reverse());
    expect(buildCodingCostFeed([...fixture].reverse().concat(reordered))).toEqual(buildCodingCostFeed(fixture));
    const events = buildCodingCostFeed(fixture).posthogEvents;
    expect(new Set(events.map(e => e.uuid)).size).toBe(events.length);
    expect(events.every(e => /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(e.uuid))).toBe(true);
    expect(events.every(e => e.properties.$process_person_profile === false)).toBe(true);
  });

  it('isolates repositories, models and engines', () => {
    const feed = buildCodingCostFeed([spend, { ...spend, repo: 'other/repo' },
      { ...spend, recordId: 'other-model', model: 'different' },
      { ...spend, recordId: 'other-engine', engine: 'claude' }, merge]);
    expect(feed.byTaskClass).toHaveLength(4);
    expect(feed.byMergedPr[0]!.groups).toHaveLength(3);
  });

  it('exposes missing task evidence and accepts late spend without changing prior event ids', () => {
    const before = buildCodingCostFeed([{ ...merge, taskIds: ['task-a', 'task-late'] }, spend]);
    expect(before.byMergedPr[0]!.missingTasks).toEqual(['task-late']);
    const after = buildCodingCostFeed([{ ...merge, taskIds: ['task-a', 'task-late'] }, spend,
      { ...spend, taskId: 'task-late', recordId: 'late' }]);
    expect(after.byMergedPr[0]!.missingTasks).toEqual([]);
    for (const event of before.posthogEvents) expect(after.posthogEvents).toContainEqual(event);
  });

  it('accepts measured zero without treating it as missing', () => {
    expect(buildCodingCostFeed([{ ...spend, costUsd: 0, tokensIn: 0, tokensOut: 0 }]).byTaskClass[0])
      .toMatchObject({ costUsd: 0, missingCost: 0, tokensIn: 0, missingTokensIn: 0 });
  });

  it('fails rather than exporting overflowing aggregate token or cost totals', () => {
    expect(() => buildCodingCostFeed([spend, { ...spend, recordId: 'huge', tokensIn: Number.MAX_SAFE_INTEGER }])).toThrow('overflow');
    expect(() => buildCodingCostFeed([{ ...spend, costUsd: Number.MAX_VALUE }, { ...spend, recordId: 'huge', costUsd: Number.MAX_VALUE }])).toThrow('overflow');
  });

  it.each([
    { costUsd: -1 }, { costUsd: Infinity }, { costUsd: null }, { costBasis: 'unknown' },
    { tokensIn: -1 }, { tokensOut: 1.5 }, { tokensIn: Number.MAX_SAFE_INTEGER + 1 },
    { timestamp: 'yesterday' }, { timestamp: '2026-02-30T12:00:00Z' }, { taskClass: '' }, { model: 'a prompt with spaces' },
    { prompt: 'private content' }, { api_key: 'private value' }, { schemaVersion: 2 },
  ])('rejects malformed or extra metadata: %j', patch => {
    expect(() => parseCodingCostRecord({ ...spend, ...patch })).toThrow(/^Invalid coding/);
  });

  it('rejects conflicting spend and merge records and ambiguous PR attribution', () => {
    expect(() => buildCodingCostFeed([spend, { ...spend, costUsd: 2 }])).toThrow('Conflicting');
    expect(() => buildCodingCostFeed([merge, { ...merge, taskIds: ['different'] }])).toThrow('Conflicting');
    expect(() => buildCodingCostFeed([merge, { ...merge, prNumber: 43 }])).toThrow('multiple merged PRs');
    expect(() => parseCodingCostRecord({ ...merge, taskIds: ['a', 'a'] })).toThrow('Invalid');
  });

  it('returns an empty feed for no events', () => {
    expect(buildCodingCostFeed([])).toEqual({ schemaVersion: 1, byTaskClass: [], byMergedPr: [], posthogEvents: [] });
  });
});

describe('PostHog coding pools dashboard JSON schema contract', () => {
  it('validates the recipe against JSON Schema and rejects missing or extra fields', () => {
    const schema = JSON.parse(readFileSync(new URL('../docs/router/posthog-coding-pools.schema.json', import.meta.url), 'utf8'));
    const dashboard = JSON.parse(readFileSync(new URL('../docs/router/posthog-coding-spend.json', import.meta.url), 'utf8'));
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    expect(validate(dashboard).valid).toBe(true);
    expect(validate({ ...dashboard, api_key: 'forbidden' }).valid).toBe(false);
    expect(validate({ ...dashboard, tiles: [] }).valid).toBe(false);
    const invalid = structuredClone(dashboard);
    delete invalid.tiles[0].query.source.kind;
    expect(validate(invalid).valid).toBe(false);
  });

  it('has named tiles containing DataTableNode/HogQLQuery nodes and matching feed fields', () => {
    const dashboard = JSON.parse(readFileSync(new URL('../docs/router/posthog-coding-spend.json', import.meta.url), 'utf8'));
    expect(Object.keys(dashboard).sort()).toEqual(['description', 'name', 'tiles']);
    expect(dashboard.name).toEqual(expect.any(String));
    expect(dashboard.description).toEqual(expect.any(String));
    expect(dashboard.tiles).toHaveLength(2);
    dashboard.tiles.forEach((tile: { name: string; query: { kind: string; source: { kind: string; query: string } } }, i: number) => {
      expect(Object.keys(tile).sort()).toEqual(['name', 'query']);
      expect(tile.name).toEqual(expect.any(String));
      expect(tile.query).toEqual({ kind: 'DataTableNode', source: { kind: 'HogQLQuery', query: expect.any(String) } });
      const sql = tile.query.source.query;
      expect(sql).toContain(i === 0 ? "event = 'coding_spend_recorded'" : "event = 'coding_merged_pr_spend'");
      for (const field of ['pool', 'taskClass', 'engine', 'model', 'tokensIn', 'tokensOut', 'costUsd', 'costBasis']) {
        expect(sql).toContain(`properties.${field}`);
      }
      for (const coverage of ['missingCost', 'missingTokensIn', 'missingTokensOut', 'estimatedCostRecords']) expect(sql).toContain(coverage);
      if (i === 1) expect(sql).toContain('GROUP BY repo, prNumber,');
    });
  });
});
