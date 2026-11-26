import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as contextMod from '../src/core/teams/context.js';
import * as directoryMod from '../src/core/teams/directory.js';
import { AGENT_ENV_MARKERS, ownerConfigPath } from '../src/core/teams/identity.js';
import * as indexMod from '../src/core/teams/index.js';
import * as membershipMod from '../src/core/teams/membership.js';
import {
  isAdminRole,
  isAssignableMemberRole,
  isHumanRole,
  normalizeHandle,
  stringList,
  validTeamId,
  type TeamActor,
} from '../src/core/teams/protocol.js';
import * as stateMod from '../src/core/teams/state.js';
import * as storeMod from '../src/core/teams/store.js';
import * as toolsMod from '../src/core/teams/tools.js';

let home = '';
let previousHome: string | undefined;
const savedMarkers: Record<string, string | undefined> = {};

function pinOwner(human: string): void {
  const path = ownerConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ human }));
}

beforeEach(() => {
  previousHome = process.env['ASHLR_HOME'];
  home = mkdtempSync(join(tmpdir(), 'teams-shared-helpers-'));
  process.env['ASHLR_HOME'] = home;
  for (const marker of AGENT_ENV_MARKERS) {
    savedMarkers[marker] = process.env[marker];
    delete process.env[marker];
  }
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = previousHome;
  for (const marker of AGENT_ENV_MARKERS) {
    if (savedMarkers[marker] === undefined) delete process.env[marker];
    else process.env[marker] = savedMarkers[marker];
  }
  rmSync(home, { recursive: true, force: true });
});

describe('teams shared helpers', () => {
  it('validates role, team id, handle, and string-list primitives consistently', () => {
    expect(isAdminRole('owner')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('agent')).toBe(false);

    expect(isHumanRole('owner')).toBe(true);
    expect(isHumanRole('admin')).toBe(true);
    expect(isHumanRole('member')).toBe(true);
    expect(isHumanRole('agent')).toBe(false);

    expect(isAssignableMemberRole('admin')).toBe(true);
    expect(isAssignableMemberRole('member')).toBe(true);
    expect(isAssignableMemberRole('owner')).toBe(false);
    expect(isAssignableMemberRole('agent')).toBe(false);

    expect(validTeamId('ashlr-core')).toBe(true);
    expect(validTeamId('team/sub')).toBe(false);
    expect(validTeamId('team..escape')).toBe(false);
    expect(validTeamId('')).toBe(false);

    expect(normalizeHandle('  Alice.Smith_1! ')).toBe('alice.smith_1');
    expect(stringList(['a', 1, null, 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(stringList('not-an-array')).toEqual([]);
  });

  it('classifies human admins and open handoffs consistently', () => {
    const members: stateMod.Member[] = [
      { id: 'human:owner', kind: 'human', role: 'owner', capabilities: [], lastSeen: '2026-11-10T00:00:00Z', online: true },
      { id: 'human:admin', kind: 'human', role: 'admin', capabilities: [], lastSeen: '2026-11-10T00:00:00Z', online: true },
      { id: 'human:member', kind: 'human', role: 'member', capabilities: [], lastSeen: '2026-11-10T00:00:00Z', online: true },
      { id: 'agent:bot', kind: 'agent', role: 'agent', capabilities: [], lastSeen: '2026-11-10T00:00:00Z', online: true },
    ];

    expect(stateMod.isHumanAdmin(members[0])).toBe(true);
    expect(stateMod.isHumanAdmin(members[1])).toBe(true);
    expect(stateMod.isHumanAdmin(members[2])).toBe(false);
    expect(stateMod.isHumanAdmin(members[3])).toBe(false);
    expect(stateMod.isHumanAdmin(undefined)).toBe(false);

    expect(stateMod.isTeamAdmin(members, 'human:owner')).toBe(true);
    expect(stateMod.isTeamAdmin(members, 'human:admin')).toBe(true);
    expect(stateMod.isTeamAdmin(members, 'human:member')).toBe(false);
    expect(stateMod.isTeamAdmin(members, 'human:missing')).toBe(false);

    const states: stateMod.HandoffState[] = ['awaiting-approval', 'open', 'accepted', 'completed', 'declined'];
    const open = states.map((state) => ({ state })).filter(stateMod.isOpenHandoff);
    expect(open.map((h) => h.state)).toEqual(['awaiting-approval', 'open', 'accepted']);
  });

  it('joins invited members using the single locked event fold and rejects revoked invites', () => {
    const owner: TeamActor = { kind: 'human', id: 'human:alice' };
    const invitee: TeamActor = { kind: 'human', id: 'human:bob' };
    pinOwner('alice');
    storeMod.appendEvent('alpha', owner, 'member.joined', {});
    const { invite } = membershipMod.inviteMember('alpha', owner, 'bob');

    const first = membershipMod.joinWithInvite(invite, invitee);
    expect(first).toMatchObject({ team: 'alpha', member: 'human:bob', joined: true, alreadyJoined: false });
    expect(first.event).toBeTruthy();

    const second = membershipMod.joinWithInvite(invite, invitee);
    expect(second).toMatchObject({ team: 'alpha', member: 'human:bob', joined: true, alreadyJoined: true, event: null });

    indexMod.updateWorkspace('alpha', owner, { type: 'member.removed', memberId: 'human:bob' });
    expect(() => membershipMod.joinWithInvite(invite, invitee)).toThrow(/No live invite/);
  });

  it('formats context evidence consistently across compileTaskContext and buildTaskBrief', () => {
    const owner: TeamActor = { kind: 'human', id: 'human:alice' };
    contextMod.addContext('alpha', owner, {
      title: 'Shared retry rule',
      text: 'Retry transient failures with bounded jitter.',
      source: 'docs/retry.md',
      scope: { owner: 'company' },
    });

    const constitution = 'version: 1\n\n## Always ask\n- Before external spend\n';
    const compiled = contextMod.compileTaskContext('alpha', { title: 'Retry handling', scope: { owner: 'company' } }, constitution);
    const brief = contextMod.buildTaskBrief({ team: 'alpha', title: 'Retry handling', owner: 'company' });
    const bulletMatch = /- Shared retry rule \[docs\/retry\.md, \d{4}-\d{2}-\d{2}\]: Retry transient failures with bounded jitter\./;
    expect(compiled.text).toMatch(bulletMatch);
    expect(brief).toMatch(bulletMatch);
  });

  it('does not re-export pruned internal helpers', () => {
    expect('newEventId' in storeMod).toBe(false);
    expect('DEFAULT_CLAIM_TTL_MS' in stateMod).toBe(false);
    expect('encodeInvite' in membershipMod).toBe(false);
    expect('compressText' in contextMod).toBe(false);
    expect('taskContextEnabled' in contextMod).toBe(false);
    expect('repoProjectSlug' in contextMod).toBe(false);
    expect('knownPools' in directoryMod).toBe(false);
    expect('agentActor' in toolsMod).toBe(false);
    for (const pruned of ['newEventId', 'DEFAULT_CLAIM_TTL_MS', 'encodeInvite', 'compressText', 'taskContextEnabled', 'repoProjectSlug', 'agentActor']) {
      expect(pruned in indexMod).toBe(false);
    }
  });
});
