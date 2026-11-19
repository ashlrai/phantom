import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildJobsTokens, JOB_TOKENS_SCHEMA, parseClaudeUsage } from '../src/core/fleet/job-tokens.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/job-tokens/${name}`, import.meta.url), 'utf8');
const now = Date.parse('2026-11-19T12:00:00Z');
const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: '2026-11-19T10:00:00Z', ...o });
const job = (id: string, lane: string, extra: Record<string, unknown> = {}, merged = true): string[] => [
  row({ event: 'launch', job: id, lane, tier: 'work', repo: 'phantom' }),
  row({ event: 'finish', job: id, ...extra }),
  ...(merged ? [row({ event: 'outcome', job: id, state: 'MERGED' })] : []),
];

describe('parseClaudeUsage', () => {
  it('reads a json result log', () => {
    expect(parseClaudeUsage(fixture('json-result.json'))).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, total_tokens: 1350, total_cost_usd: 0.5 });
  });
  it('reads the last result in a stream-json.jsonl', () => {
    expect(parseClaudeUsage(fixture('stream-json.jsonl'))?.total_tokens).toBe(135);
  });
  it('reads a json event array', () => {
    const text = JSON.stringify([{ type: 'system' }, { type: 'result', usage: { input_tokens: 3, output_tokens: 4 } }]);
    expect(parseClaudeUsage(text)).toMatchObject({ total_tokens: 7, total_cost_usd: null });
  });
  it('treats a log without usage as unmeasured', () => {
    expect(parseClaudeUsage(fixture('no-usage.txt'))).toBeNull();
    expect(parseClaudeUsage('')).toBeNull();
    expect(parseClaudeUsage('{"type":"result","usage":{}}')).toBeNull();
  });
});

describe('buildJobsTokens', () => {
  const logs: Record<string, string> = { A1: fixture('json-result.json'), A2: fixture('stream-json.jsonl'), A3: fixture('no-usage.txt') };
  const read = async (path: string): Promise<string | null> => logs[path.split('/').pop()!.replace('.log', '')] ?? null;

  it('reports coverage over a mixed set', async () => {
    const lines = [...job('A1', 'claude'), ...job('A2', 'claude'), ...job('A3', 'claude'), ...job('A4', 'claude', {}, false),
      ...job('C1', 'codex', { tokens_total: 999 }), ...job('A5', 'claude', { tokens_total: 15 })];
    const report = await buildJobsTokens(lines, '/runs', 'claude', 24, now, read);
    expect(report).toMatchObject({ schema: JOB_TOKENS_SCHEMA, lane: 'claude', jobs: 5, measured: 3, coverage: 0.6, tokens_total: 1350 + 135 + 15, merged: 4, merged_measured: 3 });
    expect(report.tokens_per_merged_pr).toBe((1350 + 135 + 15) / 3);
    expect(report.cost_usd).toBe(0.75);
  });
  it('leaves everything unknown when no job is measured', async () => {
    const report = await buildJobsTokens(job('A3', 'claude'), '/runs', 'claude', 24, now, read);
    expect(report).toMatchObject({ jobs: 1, measured: 0, coverage: 0, tokens_total: null, tokens_per_merged_pr: null, cost_usd: null });
  });
  it('has null coverage for a lane with no jobs', async () => {
    expect(await buildJobsTokens(job('C1', 'codex'), '/runs', 'zai', 24, now, read)).toMatchObject({ jobs: 0, coverage: null, known: true });
  });
});

describe('phm jobs tokens', () => {
  it('prints typed JSON with a schema id and rejects a missing lane', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { cmdJobsTokens } = await import('../src/cli/jobs-tokens.js');
    const root = mkdtempSync(join(tmpdir(), 'job-tokens-'));
    mkdirSync(join(root, 'metrics'));
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), job('A1', 'claude').join('\n') + '\n');
    writeFileSync(join(root, 'A1.log'), fixture('json-result.json'));
    const out: string[] = [];
    const spy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    const err = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdJobsTokens(['--lane', 'claude', '--json', '--metrics', join(root, 'metrics', 'jobs.jsonl')], undefined, now)).toBe(0);
      expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'jobs.tokens.v1', lane: 'claude', jobs: 1, measured: 1, coverage: 1, tokens_total: 1350, tokens_per_merged_pr: 1350 });
      expect(await cmdJobsTokens(['--json'])).toBe(2);
    } finally { spy.mockRestore(); err.mockRestore(); }
  });
});
