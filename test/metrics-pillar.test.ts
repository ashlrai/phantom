import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTelemetry, recordEvent } from '../src/core/metrics/telemetry.js';
import { quality, recommend, rollup, significance } from '../src/core/metrics/scoring.js';
import { renderDashboard } from '../src/core/metrics/dashboard.js';
import { gatherProposals } from '../src/core/improve/loop.js';

let home: string; let prev: string | undefined;
beforeEach(() => { prev = process.env['ASHLR_HOME']; home = mkdtempSync(join(tmpdir(), 'phm-metrics-')); process.env['ASHLR_HOME'] = home; });
afterEach(() => { if (prev === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prev; rmSync(home, { recursive: true, force: true }); });

const session = (id: string, agent: string, strategy: string, tokens: number, pr?: Record<string, unknown>) => {
  const base = { sessionId: id, agent, strategy, model: agent === 'codex' ? 'gpt-5' : 'opus', taskType: 'bugfix' };
  recordEvent({ ...base, kind: 'usage', inputTokens: tokens, outputTokens: 0, costUsd: tokens / 1e5, wallMs: 600_000 });
  if (pr) recordEvent({ ...base, kind: 'pr.merged', pr: { repo: 'ashlrai/phantom', number: Number(pr.number), deployedToProduction: true, ...pr } } as never);
  recordEvent({ ...base, kind: 'session.ended', outcome: pr ? 'success' : 'failure', wallMs: 600_000 });
};

describe('metrics pillar', () => {
  it('scores significance and quality sensibly', () => {
    expect(significance({ repo: 'a/b', number: 1, additions: 2000, userFacing: true, risk: 'high', areas: ['secrets'] })).toBeGreaterThan(significance({ repo: 'a/b', number: 2, additions: 5 }));
    expect(quality({ repo: 'a/b', number: 1, ciPassedFirstTry: true })).toBeGreaterThan(quality({ repo: 'a/b', number: 1, followUpFixes: 2 }));
    // non-constraining: review findings and CI retries are not penalized; size/risk only add
    expect(quality({ repo: 'a/b', number: 1, reviewFindings: 9, ciPassedFirstTry: false })).toBe(quality({ repo: 'a/b', number: 1 }));
    expect(significance({ repo: 'a/b', number: 1, additions: 20000, risk: 'high' })).toBeGreaterThan(significance({ repo: 'a/b', number: 1, additions: 200, risk: 'low' }));
    expect(quality({ repo: 'a/b', number: 1 }, [], true)).toBe(0);
    expect(quality({ repo: 'a/b', number: 1 }, [5, 5])).toBeGreaterThan(quality({ repo: 'a/b', number: 1 }, [1]));
  });

  it('refuses secrets and keeps telemetry local', () => {
    expect(() => recordEvent({ sessionId: 's', agent: 'x', kind: 'tool.called', tool: 'sk-ant-api03-' + 'a'.repeat(90), ok: true } as never)).toThrow();
    expect(readTelemetry()).toHaveLength(0);
  });

  it('rolls up value per token/hour/$ with leaderboards and a UCB1 recommendation', () => {
    session('s1', 'codex', 'tdd', 200_000, { number: 1, additions: 300, userFacing: true, ciPassedFirstTry: true });
    session('s2', 'codex', 'tdd', 100_000, { number: 2, additions: 100, ciPassedFirstTry: true });
    session('s3', 'claude-code', 'plan-first', 900_000);
    const r = rollup(readTelemetry());
    expect(r.totals.prsShipped).toBe(2);
    expect(r.byAgent[0]!.key).toBe('codex');
    expect(r.byAgent[0]!.valuePerMTok).toBeGreaterThan(0);
    expect(r.byAgent.find((a) => a.key === 'claude-code')!.value).toBe(0);
    expect(r.byDay).toHaveLength(1);
    expect(recommend(readTelemetry(), 'bugfix', ['codex', 'claude-code', 'devin']).arm).toBe('devin');
    expect(recommend(readTelemetry(), 'bugfix', ['codex', 'claude-code']).arm).toBe('codex');
    const html = renderDashboard(r, undefined, '2026-10-12T00:00:00Z');
    expect(html).toContain('value / 1M tokens');
    expect(html).toContain('By strategy');
    expect(html).not.toMatch(/<script|https?:\/\//);
    expect(html.match(/class="cta"/g)).toHaveLength(1);
  });

  it('feeds low-quality agents into the self-improvement loop', () => {
    for (let i = 1; i <= 3; i++) session(`q${i}`, 'local-model', 'yolo', 1000, { number: 10 + i, followUpFixes: 3, ciPassedFirstTry: false });
    expect(gatherProposals('default').map((p) => p.title)).toContain('Improve PR quality for local-model');
  });
});

describe('pluggable async raters', () => {
  it('samples deterministically, grades concurrently, swallows failures, and supports a Jev adapter', async () => {
    const { gradeBatch, jevRater, localModelRater, sampled } = await import('../src/core/metrics/raters.js');
    const items = Array.from({ length: 200 }, (_, i) => ({ pr: { repo: 'a/b', number: i }, title: `pr ${i}`, summary: 'x' }));
    const s = items.filter((i) => sampled(i.pr, 0.1)).length;
    expect(s).toBeGreaterThan(5); expect(s).toBeLessThan(45);
    expect(items.filter((i) => sampled(i.pr, 0.1)).length).toBe(s);
    let n = 0;
    const local = localModelRater(async () => { n++; if (n === 2) throw new Error('down'); return 'Rating: 4'; });
    const res = await gradeBatch(items.slice(0, 10), local, { concurrency: 3 });
    expect(res).toHaveLength(9);
    expect(res.every((r) => r.result.rating === 4)).toBe(true);
    const jev = jevRater(async (_state, options) => ({ label: options[4]!, confidence: 0.9 }));
    expect((await jev.rate(items[0]!)).rating).toBe(5);
  });
});
