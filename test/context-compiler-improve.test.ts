import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addContext, compileTaskContext, requestHandoff, retrieveContext, transitionHandoff, type TeamActor } from '../src/core/teams/index.js';
import { gatherProposals, isPublicEvidenceRef, openProposalPr, renderProposal, renderPublicProposal, type Exec } from '../src/core/improve/loop.js';
import type { ContextScope } from '../src/core/teams/context.js';

vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), tmpdir: vi.fn() }));

const a: TeamActor = { kind: 'agent', id: 'agent:codex/1' };
const b: TeamActor = { kind: 'agent', id: 'agent:grok-bot/m' };
const T = 't';
let home: string; let prev: string | undefined;
beforeEach(() => { prev = process.env['ASHLR_HOME']; home = mkdtempSync(join(process.cwd(), '.phm-ctx-')); vi.mocked(tmpdir).mockReturnValue(home); process.env['ASHLR_HOME'] = home; });
afterEach(() => { if (prev === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prev; rmSync(home, { recursive: true, force: true }); vi.resetAllMocks(); });
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

  const boundaries: { name: string; old: ContextScope; replacement: ContextScope; request: ContextScope }[] = [
    { name: 'another client', old: { owner: 'client:a' }, replacement: { owner: 'client:b' }, request: { owner: 'client:a' } },
    { name: 'hidden person', old: { owner: 'company', person: 'mason' }, replacement: { owner: 'company', person: 'evan' }, request: { owner: 'company', person: 'mason' } },
    { name: 'hidden project', old: { owner: 'company', project: 'a/repo' }, replacement: { owner: 'company', project: 'b/repo' }, request: { owner: 'company', project: 'a/repo' } },
    { name: 'hidden personal owner', old: { owner: 'company' }, replacement: { owner: 'personal' }, request: { owner: 'company' } },
    { name: 'different projects in a broad request', old: { owner: 'company', project: 'a/repo' }, replacement: { owner: 'company', project: 'b/repo' }, request: { owner: 'company' } },
    { name: 'different visible owner scopes', old: { owner: 'personal' }, replacement: { owner: 'company' }, request: { owner: 'personal' } },
    { name: 'unscoped project replacement', old: { owner: 'company', project: 'a/repo' }, replacement: { owner: 'company' }, request: { owner: 'company', project: 'a/repo' } },
    { name: 'unscoped person replacement', old: { owner: 'company', person: 'mason' }, replacement: { owner: 'company' }, request: { owner: 'company', person: 'mason' } },
  ];
  it.each(boundaries)('does not let $name suppress visible context', ({ old, replacement, request }) => {
    const original = addContext(T, a, { title: 'Original deployment fact', text: 'Original deployment uses signed releases.', source: 'original@1', scope: old });
    const before = retrieveContext(T, { query: 'deployment', scope: request });
    expect(before.items.map(item => item.id)).toContain(original.id);
    addContext(T, b, { title: 'Other deployment fact', text: 'Other deployment uses separate staging.', source: 'other@1', scope: replacement, supersedes: [original.id] });
    const after = retrieveContext(T, { query: 'deployment', scope: request });
    expect(after.items.map(item => item.id)).toContain(original.id);
    expect(after.items.find(item => item.id === original.id)?.source).toBe('original@1');
  });

  it('retains valid same-scope replacement chains and ignores other scoped suppression', () => {
    const scope: ContextScope = { owner: 'client:a', project: 'a/repo', person: 'mason' };
    const old = addContext(T, a, { title: 'Deployment version', text: 'Deployment version one.', source: 'deploy@1', scope });
    const middle = addContext(T, a, { title: 'Deployment version', text: 'Deployment version two.', source: 'deploy@2', scope, supersedes: [old.id] });
    const latest = addContext(T, a, { title: 'Deployment version', text: 'Deployment version three.', source: 'deploy@3', scope, supersedes: [middle.id] });
    addContext(T, b, { title: 'Other deployment version', text: 'Other deployment version four.', source: 'other@4', scope: { ...scope, owner: 'client:b' }, supersedes: [latest.id] });
    expect(retrieveContext(T, { query: 'deployment', scope }).items.map(item => item.source)).toEqual(['deploy@3']);
  });

  it('compiles task context with the constitution prefix under budget', () => {
    addContext(T, a, { title: 'Claims', text: 'Claim the branch before editing.', source: 'docs/architecture/teams.md', scope: { owner: 'company' } });
    const constitution = readFileSync(join(__dirname, '..', 'CONSTITUTION.md'), 'utf8');
    const c = compileTaskContext(T, { title: 'edit branch claims', scope: { owner: 'company' }, budgetTokens: 600 }, constitution);
    expect(c.prefix).toMatch(/constitution v3/);
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
    expect(ps[0]!.title).toBe('Reduce declined handoffs (2)');
    expect(ps[1]!.title).toMatch(/^Address feedback item [0-9a-f]{10}$/);
    expect(renderProposal(ps[1]!, { includeLocal: true })).toContain('Wizard too many clicks');
    expect(renderProposal(ps[0]!)).toContain('## Metric to move');
    const calls: string[][] = [];
    let artifact = '';
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[4]!);
      if (cmd === 'git' && args[0] === 'add') artifact = readFileSync(join(calls.find((c) => c[1] === 'worktree' && c[2] === 'add')![5]!, args[1]!), 'utf8');
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') rmSync(args[2]!, { recursive: true });
      return cmd === 'git' && args[0] === 'symbolic-ref' ? 'origin/master\n' : cmd === 'gh' ? 'https://github.com/x/y/pull/1\n' : '';
    };
    expect(openProposalPr(ps[1]!, home, exec)).toBe('https://github.com/x/y/pull/1');
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.startsWith('gh pr create --draft --base master'))).toBe(true);
    expect(flat.some((c) => /\bmerge\b|push origin master|push -f|push --force/.test(c))).toBe(false);
    // Private feedback never reaches the PR (branch, title, body, commit) or the diff.
    for (const c of flat) expect(c).not.toMatch(/Wizard|one click|tg:123/);
    expect(artifact).not.toMatch(/Wizard|one click|tg:123/);
    expect(renderPublicProposal(ps[0]!)).not.toMatch(/\(team:/);
  });

  it('--auto-merge is refused before any operation without protected admission', () => {
    addContext(T, b, { title: 'x', text: 'y', source: 'https://github.com/ashlrai/phantom/issues/1', scope: { owner: 'company' }, tags: ['bug'] });
    const [p] = gatherProposals(T);
    const exec = vi.fn<Exec>();
    expect(() => openProposalPr(p!, home, exec, { autoMerge: true })).toThrow(/protected/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('withholds GitHub links without visibility admission and all private text', () => {
    addContext(T, b, { title: 'Crash on start', text: 'secret customer detail', source: 'https://github.com/ashlrai/phantom/issues/12', scope: { owner: 'company' }, tags: ['bug'] });
    addContext(T, b, { title: 'Private DM', text: 'private', source: 'slack:dm/xyz', scope: { owner: 'company' }, tags: ['bug'] });
    const body = gatherProposals(T).map(renderPublicProposal).join('\n');
    expect(body).not.toContain('https://github.com/ashlrai/phantom/issues/12');
    expect(body).not.toMatch(/secret customer|Crash on start|Private DM|slack:dm/);
    expect(body).toContain('private evidence item(s) withheld');
    expect(isPublicEvidenceRef('https://evil.example/github.com/a/b/issues/1')).toBe(false);
  });
});
