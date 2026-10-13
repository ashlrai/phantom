import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addContext, compileTaskContext, requestHandoff, retrieveContext, transitionHandoff, type TeamActor } from '../src/core/teams/index.js';
import { gatherProposals, openProposalPr, renderProposal, type Exec } from '../src/core/improve/loop.js';

const a: TeamActor = { kind: 'agent', id: 'agent:codex/1' };
const b: TeamActor = { kind: 'agent', id: 'agent:grok-bot/m' };
const T = 't';
let home: string; let prev: string | undefined;
beforeEach(() => { prev = process.env['ASHLR_HOME']; home = mkdtempSync(join(tmpdir(), 'phm-ctx-')); process.env['ASHLR_HOME'] = home; });
afterEach(() => { if (prev === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prev; rmSync(home, { recursive: true, force: true }); });
const day = 86_400_000;

describe('evidence-scored context', () => {
  it('recency decay and importance reorder equally relevant evidence', () => {
    const now = Date.now();
    addContext(T, a, { title: 'Deploy notes old', text: 'Deploy uses vercel.', source: 's1', scope: { owner: 'company' }, observedAt: new Date(now - 90 * day).toISOString() });
    addContext(T, a, { title: 'Deploy notes new', text: 'Deploy uses vercel.', source: 's2', scope: { owner: 'company' }, observedAt: new Date(now - day).toISOString() });
    expect(retrieveContext(T, { query: 'deploy', scope: { owner: 'company' }, now }).items[0]!.source).toBe('s2');
    addContext(T, a, { title: 'Deploy critical', text: 'Deploy uses vercel.', source: 's3', scope: { owner: 'company' }, importance: 1, observedAt: new Date(now - 2 * day).toISOString() });
    expect(retrieveContext(T, { query: 'deploy', scope: { owner: 'company' }, now }).items[0]!.source).toBe('s3');
  });

  it('superseded facts are dropped', () => {
    const old = addContext(T, a, { title: 'Node version', text: 'CI uses node 20.', source: 'ci@1', scope: { owner: 'company' } });
    addContext(T, a, { title: 'Node version', text: 'CI uses node 22.', source: 'ci@2', scope: { owner: 'company' }, supersedes: [old.id] });
    const items = retrieveContext(T, { query: 'node ci', scope: { owner: 'company' } }).items;
    expect(items.map((i) => i.source)).toEqual(['ci@2']);
  });

  it('compiles task context with the constitution prefix under budget', () => {
    addContext(T, a, { title: 'Claims', text: 'Claim the branch before editing.', source: 'docs/architecture/teams.md', scope: { owner: 'company' } });
    const constitution = readFileSync(join(__dirname, '..', 'CONSTITUTION.md'), 'utf8');
    const c = compileTaskContext(T, { title: 'edit branch claims', scope: { owner: 'company' }, budgetTokens: 600 }, constitution);
    expect(c.prefix).toMatch(/constitution v1/);
    expect(c.prefix).toMatch(/deploy/);
    expect(c.text).toContain('Claim the branch');
    expect(c.tokens).toBeLessThanOrEqual(600);
  });
});

describe('constitution', () => {
  it('is versioned and carries the always-ask list', () => {
    const s = readFileSync(join(__dirname, '..', 'CONSTITUTION.md'), 'utf8');
    expect(s).toMatch(/^version: \d+$/m);
    for (const k of ['## Mission', '## Principles', '## Always ask', 'main', 'deploy', 'rotate', 'external', 'spend']) expect(s).toContain(k);
  });
});

describe('self-improvement loop', () => {
  it('derives proposals from evidence and opens draft PRs only, never on the default branch', () => {
    for (const t of ['x', 'y']) { const h = requestHandoff(T, a, { to: b.id, title: t }); transitionHandoff(T, b, h.handoffId, 'decline'); }
    addContext(T, b, { title: 'Wizard too many clicks', text: 'Users want one click setup.', source: 'tg:123', scope: { owner: 'company' }, tags: ['feedback'] });
    const ps = gatherProposals(T);
    expect(ps.map((p) => p.title)).toEqual(['Reduce declined handoffs (2)', 'Address: Wizard too many clicks']);
    expect(renderProposal(ps[0]!)).toContain('## Metric to move');
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'git' && args[0] === 'symbolic-ref' ? 'origin/master\n' : cmd === 'gh' ? 'https://github.com/x/y/pull/1\n' : ''; };
    expect(openProposalPr(ps[1]!, home, exec)).toBe('https://github.com/x/y/pull/1');
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.startsWith('gh pr create --draft --base master'))).toBe(true);
    expect(flat.some((c) => /\bmerge\b|push origin master|push -f|push --force/.test(c))).toBe(false);
  });
});
