import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { writeLeaderFacts } from '../src/core/fleet/leader-facts.js';

const now = Date.parse('2026-11-21T18:00:00Z');
const at = '2026-11-21T16:00:00Z';
const id = 'RQ-LANDEDGITN22OQ8';
const sha = 'a'.repeat(40);
const record = (subject: string, time = at, hash = sha) => `${hash}\x1f${time}\x1f${subject}\x1e`;
const offline: CloudGh = async () => { throw new Error('gh unavailable'); };
function gitFixture(log = record(`bridge(${id}): original work`), remote = 'git@github.com:ashlrai/phantom.git', fail?: string) {
  return vi.fn((args: string[], _cwd?: string): string => {
    if (args[0] === fail) throw new Error('git unavailable');
    switch (args[0]) {
      case 'remote': return remote;
      case 'symbolic-ref': return 'origin/master';
      case 'rev-parse': return 'false';
      case 'fetch': return '';
      case 'log': return args.some(arg => arg.includes('%b') || arg.includes('%B'))
        ? record(`unrelated change\n\nRelated/superseded: ${id}`) : log;
      default: throw new Error(`unexpected git command: ${args[0]}`);
    }
  });
}
async function run(gh: CloudGh, git: ReturnType<typeof gitFixture>, repo = 'phantom', withPublish = true) {
  const root = await mkdtemp(join(tmpdir(), 'leader-preservation-744s-'));
  try {
    await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'queue/router-queue.md'), `- READY ${id} (repo=${repo}, src=leader): work\n`);
    await writeFile(join(root, 'metrics/jobs.jsonl'), withPublish ? JSON.stringify({
      id, event: 'publish', ts: '2026-11-21T15:00:00Z',
      pr_url: `https://github.com/ashlrai/${repo}/pull/7850`, result: 'ok',
    }) : '');
    const facts = await writeLeaderFacts(root, gh, now, { git, cwd: '/fake/nonsecret/checkout' });
    expect(JSON.parse(await readFile(join(root, 'leader/facts.json'), 'utf8'))).toEqual(facts);
    expect(facts.schema).toBe('leader.facts.v1');
    return facts;
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('leader facts git preservation for #7850', () => {
  it('writes merged evidence from the existing subject reader when gh fails, keeping oldest time', async () => {
    const git = gitFixture(record(`bridge(${id}): followup`, '2026-11-21T17:00:00Z', 'b'.repeat(40)) + record(`bridge(${id}): original`));
    const facts = await run(offline, git);
    expect(facts.jobs[0]).toMatchObject({ id, repo: 'ashlrai/phantom', pr_state: 'merged', merged_at: at, source: 'git' });
    expect(facts.sources.github).toBe('partial');
    expect(facts.repos[0]).toMatchObject({ merged_24h: null, latest_release_tag: null });
    expect(git.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1);
    expect(git.mock.calls.find(([args]) => args[0] === 'log')?.[0]).toContain('--format=%H\x1f%cI\x1f%s\x1e');
    expect(git.mock.calls.every(([, cwd]) => cwd === '/fake/nonsecret/checkout')).toBe(true);
  });

  it.each(['remote', 'fetch', 'log'])('preserves unknown when git %s fails', async fail => {
    const facts = await run(offline, gitFixture(undefined, undefined, fail));
    expect(facts.jobs[0]).toMatchObject({ pr_state: null, merged_at: null });
    expect(facts.jobs[0]).not.toHaveProperty('source');
  });

  it.each(['ashlr-md', 'other-owner'])('does not borrow a matching id from another repo (%s)', async other => {
    const remote = other === 'other-owner' ? 'https://github.com/other-owner/phantom.git' : 'git@github.com:ashlrai/ashlr-md.git';
    const facts = await run(offline, gitFixture(undefined, remote));
    expect(facts.jobs[0]).toMatchObject({ pr_state: null, merged_at: null });
  });

  it.each(['open', 'closed'])('preserves authoritative gh %s without reading git', async state => {
    const gh: CloudGh = async args => ({ ok: true, stderr: '', stdout: JSON.stringify(
      args[1]?.includes('/pulls/') ? { state, merged_at: null } : { incomplete_results: false, items: [], total_count: 0 },
    ) });
    const git = gitFixture();
    const facts = await run(gh, git);
    expect(facts.jobs[0]).toMatchObject({ pr_state: state, merged_at: null });
    expect(git).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'missing id'],
    [record(`bridge(${id}-RELATED): other job`), 'prefix only'],
    [record('unrelated change'), 'body only'],
    [record(`bridge(${id}): malformed`, 'bad-time'), 'invalid time'],
    [record(`bridge(${id}): malformed`, at, 'not-a-sha'), 'invalid sha'],
    [record(`bridge(${id}): future`, '2026-11-22T16:00:00Z'), 'future time'],
  ])('leaves unknown for %s (%s)', async log => {
    const facts = await run(offline, gitFixture(log));
    expect(facts.jobs[0]).toMatchObject({ pr_state: null, merged_at: null });
  });

  it('does not invent a PR state without a published PR', async () => {
    const git = gitFixture();
    const facts = await run(offline, git, 'phantom', false);
    expect(facts.jobs[0]).toMatchObject({ pr_url: null, pr_state: null, merged_at: null });
    expect(git).not.toHaveBeenCalled();
  });
});
