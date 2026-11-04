import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { auditAutonomy, formatAutonomy, GitHubNotFoundError } from '../src/core/release/autonomy-audit.js';
import { cmdReleaseAutonomy } from '../src/cli/release-autonomy.js';

interface FixtureRepo {
  name: string; branch: string; mergeQueue: boolean; tagRulesets: string[];
  autoTag: boolean; finalize?: boolean; manualCi?: boolean;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/release-autonomy/nov-04.json', import.meta.url), 'utf8')) as { repos: FixtureRepo[] };

function endpointFixture() {
  const endpoints: Record<string, unknown> = {};
  for (const repo of fixture.repos) {
    const prefix = `repos/ashlrai/${repo.name}`;
    endpoints[prefix] = { default_branch: repo.branch, allow_auto_merge: true };
    const rulesets: Array<{ id: number; name: string; target: string; enforcement: string; rules: Array<{ type: string }>; conditions?: { ref_name: { include: string[]; exclude: string[] } } }> = repo.tagRulesets.map((name, index) => ({ id: index + 1, name, target: 'tag', enforcement: 'disabled', rules: [{ type: 'update' }, { type: 'deletion' }] }));
    if (repo.mergeQueue) rulesets.push({ id: 99, name: 'default branch merge queue', target: 'branch', enforcement: 'active', rules: [{ type: 'merge_queue' }], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } } });
    endpoints[`${prefix}/rulesets?per_page=100&page=1`] = rulesets;
    endpoints[`${prefix}/rules/branches/${repo.branch}?per_page=100&page=1`] = repo.mergeQueue ? [{ type: 'merge_queue' }] : [];
    for (const rule of rulesets) endpoints[`${prefix}/rulesets/${rule.id}`] = rule;
    endpoints[`${prefix}/branches/${repo.branch}/protection`] = {
      required_status_checks: { contexts: ['Merge Gate'] },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      required_merge_queue: repo.mergeQueue && repo.name !== 'lexicon' ? {} : null,
    };
    endpoints[`${prefix}/environments?per_page=100&page=1`] = { total_count: repo.finalize ? 1 : 0, environments: repo.finalize ? [{ name: 'github-stable-release-finalization', protection_rules: [] }] : [] };
    const workflows = [
      ...(repo.autoTag ? [{ id: 1, name: 'Auto tag', path: '.github/workflows/auto-tag.yml', state: 'active' }] : []),
      ...(repo.finalize ? [{ id: 2, name: 'Finalize', path: '.github/workflows/finalize-github-release.yml', state: 'active' }] : []),
      ...(repo.manualCi ? [{ id: 3, name: 'Release', path: '.github/workflows/release.yml', state: 'active' }] : []),
    ];
    endpoints[`${prefix}/actions/workflows?per_page=100&page=1`] = { total_count: workflows.length, workflows };
    for (const workflow of workflows) {
      const source = workflow.id === 1 ? 'on: push\n' : 'on: workflow_dispatch\n';
      endpoints[`${prefix}/contents/${workflow.path}`] = { encoding: 'base64', content: Buffer.from(source).toString('base64'), size: Buffer.byteLength(source), type: 'file' };
      endpoints[`${prefix}/actions/workflows/${workflow.path.split('/').pop()}/runs?per_page=1`] = { total_count: 1, workflow_runs: [{ conclusion: 'success', status: 'completed' }] };
    }
  }
  return endpoints;
}

describe('release autonomy fixture', () => {
  test('inventories seven repos and classifies the amendment 2 gates', async () => {
    const endpoints = endpointFixture();
    const calls: string[] = [];
    const report = await auditAutonomy({ read: async (endpoint: string) => {
      calls.push(endpoint);
      if (endpoint === 'repos/ashlrai/locus/contents/.github/workflows/auto-tag.yml') throw new GitHubNotFoundError();
      if (!(endpoint in endpoints)) throw new Error(`fixture missing ${endpoint}`);
      return endpoints[endpoint];
    }, publishHold: { on: false, sourceState: 'fixture' } });
    expect(report.repos).toHaveLength(7);
    expect(report.repos.map(r => r.repo)).toEqual(fixture.repos.map(r => `ashlrai/${r.name}`));
    for (const repo of report.repos) {
      expect(repo.allowAutoMerge).toBe(true);
      expect(repo.items.filter(item => item.id.startsWith('ruleset:')).every(item => item.status === 'ok' && item.detail.includes('disabled'))).toBe(true);
      expect(repo.mergeQueue).toBe(fixture.repos.find(f => repo.repo.endsWith(`/${f.name}`))?.mergeQueue);
    }
    expect(report.repos.find(r => r.repo.endsWith('/locus'))?.autoTag.exists).toBe(false);
    expect(report.repos.find(r => r.repo.endsWith('/locus'))?.items.find(item => item.id === 'auto-tag')?.status).toBe('human step');
    expect(report.repos.find(r => r.repo.endsWith('/phantom'))?.autoTag.conclusion).toBe('success');
    expect(report.gates.length).toBeGreaterThan(0);
    expect(report.gates.every(g => ['cut', 'automate', 'hard-limit'].includes(g.classification) && !!g.reason && !!g.where && !!g.kind && !!g.id)).toBe(true);
    expect(calls.every(path => path.startsWith('repos/ashlrai/') && !/\s/.test(path))).toBe(true);
    expect(formatAutonomy(report, true)).toContain('|');
  });

  test('preserves unknown evidence when GitHub reads fail', async () => {
    const endpoints = endpointFixture();
    delete endpoints['repos/ashlrai/locus/actions/workflows?per_page=100&page=1'];
    const report = await auditAutonomy({ repo: 'locus', read: async (endpoint: string) => {
      if (!(endpoint in endpoints)) throw new Error('unavailable');
      return endpoints[endpoint];
    }, publishHold: { on: null, sourceState: 'unknown' } });
    const repo = report.repos[0];
    expect(repo.autoTag.exists).toBeNull();
    expect(repo.items.find(item => item.id === 'workflows')?.status).toBe('unknown');
    expect(repo.items.find(item => item.id === 'publish-hold')?.status).toBe('unknown');
  });

  test('reports environment reviewers, timers, and manual workflows', async () => {
    const endpoints = endpointFixture();
    endpoints['repos/ashlrai/phantom/environments?per_page=100&page=1'] = { environments: [{ name: 'production', protection_rules: [
      { type: 'required_reviewers', reviewers: [{ type: 'User', id: 1 }] },
      { type: 'wait_timer', wait_timer: 15 },
    ] }] };
    const report = await auditAutonomy({ repo: 'phantom', read: async (endpoint: string) => {
      if (!(endpoint in endpoints)) throw new Error('unavailable');
      return endpoints[endpoint];
    }, publishHold: { on: true, sourceState: 'healthy' } });
    const items = report.repos[0].items;
    expect(items.find(item => item.id === 'publish-hold')?.status).toBe('human step');
    expect(items.filter(item => item.id.startsWith('environment:')).map(item => item.status)).toEqual(['human step', 'human step']);
    expect(items.find(item => item.id.includes('finalize-github-release.yml'))?.status).toBe('human step');
  });

  test('rejects unknown repository before any read', async () => {
    let calls = 0;
    await expect(auditAutonomy({ repo: '../bad', read: async () => { calls++; return {}; } })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('CLI accepts JSON and Markdown, rejects conflicting output flags', async () => {
    const output: string[] = [];
    const emit = (text: string) => { output.push(text); };
    expect(await cmdReleaseAutonomy(['autonomy', '--help'], { emit })).toBe(0);
    expect(output.join()).toContain('--json');
    expect(await cmdReleaseAutonomy(['autonomy', '--json', '--md'], { emit })).toBe(2);
    expect(await cmdReleaseAutonomy(['autonomy', '--repo'], { emit })).toBe(2);
  });
});
