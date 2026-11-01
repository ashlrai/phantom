import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';
import {
  collectRealSupply,
  rankRealSupply,
  realSupplyBriefLines,
  REAL_SUPPLY_BRIEF_CAP,
  type RealSupplyFacts,
  type RealSupplyReader,
  type RealSupplyV1,
} from '../src/core/fleet/planner-real-supply.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { QUEUEGEN_REPOS } from '../src/core/drive/queuegen.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const clock = () => NOW;

const alert = (pkg: string, severity: string, manifest = 'package-lock.json', patched: string | null = '1.0.1') => ({
  dependency: { package: { name: pkg }, manifest_path: manifest },
  security_vulnerability: {
    package: { name: pkg }, severity,
    first_patched_version: patched === null ? null : { identifier: patched },
  },
});

const run = (workflowId: number, name: string, conclusion: string | null) =>
  ({ workflow_id: workflowId, name, status: 'completed', conclusion });

const issue = (number: number, title: string, pr = false) =>
  ({ number, title, ...(pr ? { pull_request: {} } : {}) });

/** Fake gh: longest-prefix endpoint (args[1]) match → body, or `{ fail: stderr }` to fail. */
function fakeGh(responses: Record<string, unknown>): { gh: CloudGh; calls: string[] } {
  const calls: string[] = [];
  const gh: CloudGh = async (args) => {
    const endpoint = args[1]!;
    calls.push(endpoint);
    const key = Object.keys(responses)
      .filter(k => endpoint === k || endpoint.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const r = key === undefined ? undefined : responses[key];
    if (r === undefined) return { ok: false, stdout: '', stderr: 'not stubbed' };
    if (typeof r === 'object' && r !== null && 'fail' in r) {
      return { ok: false, stdout: '', stderr: String((r as { fail: unknown }).fail) };
    }
    if (typeof r === 'object' && r !== null && 'raw' in r) {
      return { ok: true, stdout: String((r as { raw: unknown }).raw), stderr: '' };
    }
    return { ok: true, stdout: JSON.stringify(r), stderr: '' };
  };
  return { gh, calls };
}

/** All seven repos stubbed clean (master branch, no alerts/runs/issues), plus overrides. */
const cleanRepos = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...Object.fromEntries(QUEUEGEN_REPOS.flatMap(repo => [
    [`repos/${repo}`, { default_branch: 'master' }],
    [`repos/${repo}/dependabot/alerts`, []],
    [`repos/${repo}/actions/runs`, { workflow_runs: [] }],
    [`repos/${repo}/issues`, []],
  ])),
  ...over,
});

const facts = (over: Partial<RealSupplyFacts> = {}): RealSupplyFacts =>
  ({ alerts: [], redSuite: null, issues: [], ...over });

describe('rankRealSupply', () => {
  it('orders critical alerts, the red suite, high alerts, then issues', () => {
    const candidates = rankRealSupply([
      {
        repo: 'ashlrai/zeta',
        facts: facts({
          alerts: [
            { package: 'hi-pkg', manifest: 'yarn.lock', severity: 'high', patched: '2.0.0' },
            { package: 'crit-pkg', manifest: 'package-lock.json', severity: 'critical', patched: '1.4.0' },
            { package: 'med-pkg', manifest: 'package-lock.json', severity: 'medium', patched: '3.0.0' },
          ],
          redSuite: { workflow: 'Nightly', branch: 'master' },
          issues: [{ number: 9, title: 'crash on start' }],
        }),
      },
      {
        repo: 'ashlrai/alpha',
        facts: facts({
          alerts: [{ package: 'alpha-crit', manifest: 'package-lock.json', severity: 'critical', patched: '9.9.9' }],
        }),
      },
    ]);
    expect(candidates.map(c => `${c.kind}:${c.repo}`)).toEqual([
      'dependabot-critical:ashlrai/alpha',
      'dependabot-critical:ashlrai/zeta',
      'scheduled-red:ashlrai/zeta',
      'dependabot-high:ashlrai/zeta',
      'issue:ashlrai/zeta',
    ]);
    expect(candidates[0]).toMatchObject({
      target: 'package-lock.json (alpha-crit -> 9.9.9)',
      goal: 'Bump alpha-crit to 9.9.9 in package-lock.json (critical Dependabot alert)',
    });
    expect(candidates[2]).toMatchObject({
      target: 'Nightly',
      goal: 'Fix scheduled workflow "Nightly" — its latest run on master failed',
    });
    expect(candidates[4]).toMatchObject({ target: '#9', goal: 'Resolve issue #9: crash on start' });
  });

  it('dedupes the same package across alerts, keeping the worst severity', () => {
    const candidates = rankRealSupply([{
      repo: 'ashlrai/ashlr-plugin',
      facts: facts({
        alerts: [
          { package: 'lodash', manifest: 'package-lock.json', severity: 'high', patched: '4.17.21' },
          { package: 'lodash', manifest: 'web/package-lock.json', severity: 'critical', patched: '4.17.21' },
          { package: 'lodash', manifest: 'package-lock.json', severity: 'medium', patched: '4.17.21' },
          { package: 'minimatch', manifest: 'package-lock.json', severity: 'high', patched: '9.0.6' },
        ],
      }),
    }]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      repo: 'ashlrai/ashlr-plugin', kind: 'dependabot-critical',
      target: 'web/package-lock.json (lodash -> 4.17.21)',
    });
    expect(candidates[1]).toMatchObject({ kind: 'dependabot-high', target: 'package-lock.json (minimatch -> 9.0.6)' });
  });
});

describe('collectRealSupply', () => {
  it('reads all seven repos through gh api GETs and ranks the supply', async () => {
    const { gh, calls } = fakeGh(cleanRepos({
      'repos/ashlrai/phantom/dependabot/alerts': [alert('crit-dep', 'critical', 'package-lock.json', '7.7.7')],
      'repos/ashlrai/phantom/actions/runs': { workflow_runs: [run(1, 'Merge Gate', 'success')] },
      'repos/ashlrai/phantom/issues': [issue(42, 'planner writes filler'), issue(43, 'not an issue', true)],
      'repos/ashlrai/locus/actions/runs': {
        workflow_runs: [run(7, 'Nightly', 'failure'), run(7, 'Nightly', 'success'), run(3, 'Audit', 'success')],
      },
    }));
    const supply = await collectRealSupply({ gh, now: clock });
    expect(supply).toMatchObject({ v: 1, generatedAt: NOW.toISOString() });
    expect(supply.repos).toEqual(QUEUEGEN_REPOS.map(repo => ({ repo, status: 'ok' })));
    expect(supply.candidates.map(c => `${c.kind}:${c.repo}:${c.target}`)).toEqual([
      'dependabot-critical:ashlrai/phantom:package-lock.json (crit-dep -> 7.7.7)',
      'scheduled-red:ashlrai/locus:Nightly',
      'issue:ashlrai/phantom:#42',
    ]);
    expect(calls).toContain('repos/ashlrai/locus/actions/runs?event=schedule&branch=master&per_page=50');
    expect(calls.every(c => c.startsWith('repos/ashlrai/'))).toBe(true);
  });

  it('marks a failed repo unknown, never crashes and never reports an empty success', async () => {
    const reader: RealSupplyReader = async (repo) => {
      if (repo === 'ashlrai/lexicon') throw new Error('socket hang up');
      if (repo === 'ashlrai/locus') return { ok: false, reason: 'gh api repos/ashlrai/locus failed (HTTP 403)' };
      return { ok: true, facts: facts() };
    };
    const supply = await collectRealSupply({ reader, now: clock });
    expect(supply.candidates).toEqual([]);
    expect(supply.repos).toHaveLength(QUEUEGEN_REPOS.length);
    const lexicon = supply.repos.find(r => r.repo === 'ashlrai/lexicon')!;
    const locus = supply.repos.find(r => r.repo === 'ashlrai/locus')!;
    expect(lexicon).toMatchObject({ status: 'unknown' });
    expect(lexicon.reason).toContain('socket hang up');
    expect(locus.reason).toContain('HTTP 403');
    expect(supply.repos.filter(r => r.status === 'ok')).toHaveLength(5);
  });

  it('fails the repo read on malformed API payloads', async () => {
    const { gh } = fakeGh(cleanRepos({
      'repos/ashlrai/phantom/dependabot/alerts': { raw: '<html>rate limited</html>' },
      'repos/ashlrai/phantom-secrets/actions/runs': { nope: 1 },
    }));
    const supply = await collectRealSupply({ gh, repos: ['ashlrai/phantom', 'ashlrai/phantom-secrets'], now: clock });
    expect(supply.repos).toEqual([
      { repo: 'ashlrai/phantom', status: 'unknown', reason: 'gh api repos/ashlrai/phantom/dependabot/alerts?state=open&per_page=100 did not return JSON' },
      { repo: 'ashlrai/phantom-secrets', status: 'unknown', reason: 'gh api actions/runs for ashlrai/phantom-secrets returned an invalid listing' },
    ]);
  });
});

const candidates = (n: number, repo = 'ashlrai/phantom') => Array.from({ length: n }, (_, i) => ({
  repo, kind: 'dependabot-critical' as const,
  target: `package-lock.json (pkg${i} -> 1.0.0)`, goal: `Bump pkg${i} to 1.0.0 in package-lock.json`,
}));

describe('realSupplyBriefLines', () => {
  const supply = (count: number, unknown = 0): RealSupplyV1 => ({
    v: 1, generatedAt: NOW.toISOString(),
    repos: [
      ...Array.from({ length: unknown }, (_, i) => ({ repo: `ashlrai/unread-${i}`, status: 'unknown' as const, reason: 'gh offline' })),
      { repo: 'ashlrai/phantom', status: 'ok' },
    ],
    candidates: candidates(count),
  });

  it('caps the section at 15 lines and names the hidden remainder', () => {
    const lines = realSupplyBriefLines(supply(20, 3));
    expect(lines).toHaveLength(REAL_SUPPLY_BRIEF_CAP);
    expect(lines[0]).toBe('ashlrai/phantom: Bump pkg0 to 1.0.0 in package-lock.json');
    expect(lines[13]).toBe('ashlrai/phantom: Bump pkg13 to 1.0.0 in package-lock.json');
    expect(lines[14]).toBe('… 9 more');
  });

  it('shows unread repos after candidates and a clean marker when empty', () => {
    expect(realSupplyBriefLines(supply(0, 2))).toEqual([
      'ashlrai/unread-0: supply unread (gh offline)',
      'ashlrai/unread-1: supply unread (gh offline)',
    ]);
    expect(realSupplyBriefLines(supply(0, 0))).toEqual([
      '(all repos read; no open alerts, red scheduled suites or issues)',
    ]);
  });
});

describe('planner brief real supply section', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it('embeds ## REAL SUPPLY between LANES and USED IDS, capped at 15 lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brief-supply-'));
    roots.push(root);
    const realSupply = async (): Promise<RealSupplyV1> => ({
      v: 1, generatedAt: NOW.toISOString(),
      repos: [{ repo: 'ashlrai/ashlr-plugin', status: 'ok' }],
      candidates: candidates(20, 'ashlrai/ashlr-plugin'),
    });
    const brief = await buildPlannerBrief({ runsRoot: root, git: (_p, _a, _o, done) => done(null, ''), realSupply });
    expect(brief.sections['realSupply']).toBe(REAL_SUPPLY_BRIEF_CAP);
    const section = brief.text.slice(brief.text.indexOf('## REAL SUPPLY'));
    expect(brief.text.indexOf('## LANES')).toBeLessThan(brief.text.indexOf('## REAL SUPPLY'));
    expect(brief.text.indexOf('## REAL SUPPLY')).toBeLessThan(brief.text.indexOf('## USED IDS'));
    expect(section.split('\n').slice(1, 16)).toHaveLength(15);
    expect(section).toContain('ashlrai/ashlr-plugin: Bump pkg0 to 1.0.0 in package-lock.json');
    expect(section).toContain('… 6 more');
  });

  it('omits the section without a reader and marks it missing on a throwing reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brief-supply-'));
    roots.push(root);
    const git: PlannerBriefGit = (_p, _a, _o, done) => done(null, '');
    const without = await buildPlannerBrief({ runsRoot: root, git });
    expect(without.text).not.toContain('REAL SUPPLY');
    expect(without.sections['realSupply']).toBeUndefined();
    const failing = await buildPlannerBrief({
      runsRoot: root, git,
      realSupply: () => { throw new Error('supply exploded'); },
    });
    expect(failing.missing).toContain('real-supply');
    expect(failing.text).toContain('## REAL SUPPLY\n(unavailable: real supply read failed)');
  });
});
