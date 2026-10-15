import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addContext, type TeamActor } from '../src/core/teams/index.js';
import { buildTaskBrief } from '../src/core/teams/task-brief.js';
import type { AshlrConfig } from '../src/core/types.js';

const agent: TeamActor = { kind: 'agent', id: 'agent:claude/1' };
let home: string; let repo: string; let prev: string | undefined;
beforeEach(() => {
  prev = process.env['ASHLR_HOME'];
  home = mkdtempSync(join(tmpdir(), 'phm-brief-home-'));
  repo = mkdtempSync(join(tmpdir(), 'phm-brief-repo-'));
  process.env['ASHLR_HOME'] = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prev;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('task brief for dispatched agents', () => {
  it('is empty when the repo has no constitution and the team recorded nothing', () => {
    expect(buildTaskBrief({ repo, title: 'fix the build' })).toBe('');
  });

  it('carries the repo constitution always-ask list and matching team evidence', () => {
    copyFileSync(join(__dirname, '..', 'CONSTITUTION.md'), join(repo, 'CONSTITUTION.md'));
    const project = repo.split('/').pop()!;
    addContext('default', agent, { title: 'Release branch', text: 'Release work lands on the 3.29.16 branch first.', source: 'notes/release.md', scope: { owner: 'company', project } });
    const brief = buildTaskBrief({ repo, title: 'prepare the release notes' });
    expect(brief).toMatch(/^\n\n---\n## Task context \(compiled by Phantom\)/);
    expect(brief).toMatch(/constitution v\d+ applies/);
    expect(brief).toMatch(/deploy/i);
    expect(brief).toContain('3.29.16 branch first');
  });

  it('never leaks personal or another project\'s context into the prompt', () => {
    const project = repo.split('/').pop()!;
    addContext('default', agent, { title: 'Personal note', text: 'Private release reminder.', source: 'me', scope: { owner: 'personal' } });
    addContext('default', agent, { title: 'Other repo', text: 'Other release process.', source: 'x', scope: { owner: 'company', project: 'someone/else' } });
    addContext('default', agent, { title: 'This repo', text: 'This release process.', source: 'y', scope: { owner: 'company', project } });
    const brief = buildTaskBrief({ repo, title: 'release process' });
    expect(brief).toContain('This release process.');
    expect(brief).not.toContain('Private release');
    expect(brief).not.toContain('Other release');
  });

  it('is off with foundry.taskContext false', () => {
    copyFileSync(join(__dirname, '..', 'CONSTITUTION.md'), join(repo, 'CONSTITUTION.md'));
    const cfg = { foundry: { taskContext: false } } as unknown as AshlrConfig;
    expect(buildTaskBrief({ repo, title: 'anything', cfg })).toBe('');
  });
});
