import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ENV_MARKERS, ownerConfigPath } from '../src/core/teams/identity.js';
import { appendEvent, importEvents, readEvents, teamDir, teamState, type TeamActor } from '../src/core/teams/index.js';
import { readTeamAudit, updateWorkspace, type WorkspaceAction } from '../src/core/teams/workspace.js';
import { cmdTeam } from '../src/cli/team.js';
import { cmdAudit } from '../src/cli/audit.js';

const owner: TeamActor = { kind: 'human', id: 'human:owner' };
let home: string;
const T = 'audit-test';
const log = () => readFileSync(join(teamDir(T), 'events.jsonl'), 'utf8');
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-audit-'));
  vi.stubEnv('ASHLR_HOME', home);
  for (const marker of AGENT_ENV_MARKERS) vi.stubEnv(marker, '');
  mkdirSync(dirname(ownerConfigPath()), { recursive: true });
  writeFileSync(ownerConfigPath(), JSON.stringify({ human: 'owner' }));
  appendEvent(T, owner, 'member.joined', {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('workspace audit', () => {
  it('appends one attributed, durable entry per action and folds the workspace', async () => {
    const actions = [
      ['invite', 'human:guest'], ['role', 'human:guest', 'admin'], ['link', 'AshlrAI/Phantom'],
    ];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const action of actions) {
      const before = log();
      expect(await cmdTeam([...action, '--team', T, '--as', 'impostor'])).toBe(0);
      expect(log().startsWith(before)).toBe(true);
      expect(log().split('\n').length).toBe(before.split('\n').length + 1);
    }
    expect(readTeamAudit(T).map(e => e.type)).toEqual(['repo.linked', 'member.role-changed', 'member.invited', 'member.joined']);
    expect(readTeamAudit(T).every(e => e.actor.id === owner.id && e.ts && e.id)).toBe(true);
    expect(readTeamAudit(T)[1]?.payload).toMatchObject({ previousRole: 'member', role: 'admin' });
    expect(teamState(T).repos).toEqual(['ashlrai/phantom']);
    expect(teamState(T).members.find(m => m.id === 'human:guest')?.role).toBe('admin');
  });

  it('lists and filters newest matching actions without writing', async () => {
    updateWorkspace(T, owner, { type: 'member.invited', memberId: 'human:guest' });
    updateWorkspace(T, owner, { type: 'repo.linked', repo: 'a/b' });
    const before = log();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdAudit(['--team', T, '--json', '--action', 'member.invited', '--limit', '1'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([readTeamAudit(T)[1]]);
    expect(await cmdAudit(['--team', T, '--since', '2999-01-01', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([]);
    expect(await cmdAudit(['--team', T])).toBe(0);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain('repo.linked');
    expect(log()).toBe(before);
  });

  it('cannot rewrite history through returned records, peer imports or unsupported API actions', async () => {
    updateWorkspace(T, owner, { type: 'repo.linked', repo: 'a/b' });
    const before = log();
    const entries = readTeamAudit(T);
    entries[0]!.payload.repo = 'evil/rewrite';
    expect(importEvents(T, entries)).toBe(0);
    expect(() => updateWorkspace(T, owner, { type: 'audit.replace', entries: [] } as unknown as WorkspaceAction)).toThrow();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdAudit(['--team', T, '--delete'])).toBe(2);
    expect(await cmdAudit(['--team', T, '--rewrite'])).toBe(2);
    expect(log()).toBe(before);
    expect(readEvents(T).at(-1)?.payload.repo).toBe('a/b');
  });

  it('rejects invalid, duplicate and unauthorized changes without appending', () => {
    updateWorkspace(T, owner, { type: 'member.invited', memberId: 'human:guest' });
    updateWorkspace(T, owner, { type: 'repo.linked', repo: 'a/b' });
    const before = log();
    const bad: WorkspaceAction[] = [
      { type: 'member.invited', memberId: 'human:guest' },
      { type: 'member.invited', memberId: 'agent:bot' },
      { type: 'member.role-changed', memberId: owner.id, role: 'member' },
      { type: 'member.role-changed', memberId: 'human:missing', role: 'admin' },
      { type: 'member.role-changed', memberId: 'human:guest', role: 'owner' } as unknown as WorkspaceAction,
      { type: 'repo.linked', repo: '../escape/path' },
      { type: 'repo.linked', repo: 'A/B' },
    ];
    for (const action of bad) expect(() => updateWorkspace(T, owner, action)).toThrow();
    expect(() => updateWorkspace(T, { kind: 'human', id: 'human:guest' }, { type: 'repo.linked', repo: 'c/d' })).toThrow();
    writeFileSync(ownerConfigPath(), JSON.stringify({ human: 'guest' }));
    expect(() => updateWorkspace(T, { kind: 'human', id: 'human:guest' }, { type: 'repo.linked', repo: 'c/d' })).toThrow(/owner\/admin/);
    vi.stubEnv('CODEX_THREAD_ID', 'test');
    expect(() => updateWorkspace(T, owner, { type: 'repo.linked', repo: 'c/d' })).toThrow(/agent process/);
    expect(log()).toBe(before);
  });
});
