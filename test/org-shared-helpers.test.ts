import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OrgError,
  formatOrgJoinCommand,
  joinRecordFilename,
  joinRecordPath,
  orgIdSchema,
  orgJoinRecordSchema,
  parseOrgAgentSpecs,
  parseOrgLaneSpecs,
} from '../src/core/org/org.js';
import {
  OrgStoreError,
  orgPlanePaths,
  orgStoreErrorMessage,
  parseOrgPlaneCliArgs,
  refuseOrgStore,
  undeliveredLedgerEntries,
} from '../src/core/org/agent-plane-reader.js';
import {
  ORG_PLANE_STATUSES,
  ORG_PLANE_TIERS,
  orgPlaneIdSchema,
  orgPlaneNeedTokenSchema,
  type OrgPlane,
} from '../src/core/org/agent-plane-schema.js';

describe('org shared org.toml and CLI helpers', () => {
  it('formats join record filenames, paths, and runnable join commands consistently', () => {
    expect(joinRecordFilename('ada', 'ada-mac')).toBe('ada.ada-mac.json');
    expect(joinRecordPath('ada', 'ada-mac', '/tmp/joins')).toBe(join('/tmp/joins', 'ada.ada-mac.json'));

    expect(formatOrgJoinCommand('ada', 'ada-mac')).toBe('phm org join --member ada --machine ada-mac');
    expect(
      formatOrgJoinCommand('ada', 'ada-mac', [{ lane: 'claude', share: 50 }, 'devin', { lane: 'codex' }]),
    ).toBe('phm org join --member ada --machine ada-mac --lane claude=50 --lane devin --lane codex');
  });

  it('parses --lane specs in both bounded init mode and unbounded join mode', () => {
    expect(parseOrgLaneSpecs(['claude', 'devin=20', 'codex=0'], { defaultShare: 100 })).toEqual([
      { lane: 'claude', share: 100 },
      { lane: 'devin', share: 20 },
      { lane: 'codex', share: 0 },
    ]);
    expect(parseOrgLaneSpecs(['claude', 'devin=20'])).toEqual([
      { lane: 'claude', share: undefined },
      { lane: 'devin', share: 20 },
    ]);

    expect(() => parseOrgLaneSpecs(['claude=10=20'])).toThrow(OrgError);
    expect(() => parseOrgLaneSpecs(['=20'])).toThrow(/needs a lane name/);
    expect(() => parseOrgLaneSpecs(['claude='])).toThrow(/share must be a number:/);
    expect(() => parseOrgLaneSpecs(['claude=101'], { defaultShare: 100 })).toThrow(/from 0 to 100/);
    expect(() => parseOrgLaneSpecs(['claude=-1'], { defaultShare: 100 })).toThrow(/from 0 to 100/);
    expect(() => parseOrgLaneSpecs(['claude', 'claude=50'])).toThrow(/more than once/);
  });

  it('parses --agent <id>:<lane> specs and rejects malformed or duplicate entries', () => {
    expect(parseOrgAgentSpecs(['ada-claude:claude', 'ada-devin:devin'])).toEqual([
      { id: 'ada-claude', lane: 'claude' },
      { id: 'ada-devin', lane: 'devin' },
    ]);

    for (const bad of ['ada-claude', ':claude', 'ada-claude:', 'a:b:c']) {
      expect(() => parseOrgAgentSpecs([bad])).toThrow(/--agent takes <id>:<lane>/);
    }
    expect(() => parseOrgAgentSpecs(['a1:claude', 'a1:devin'])).toThrow(/more than once/);
  });

  it('shares canonical org id and join-record schemas', () => {
    expect(orgIdSchema.safeParse('mason-wyatt').success).toBe(true);
    expect(orgIdSchema.safeParse('Bad_ID').success).toBe(false);

    expect(
      orgJoinRecordSchema.safeParse({
        v: 1,
        member: 'ada',
        machine: 'ada-mac',
        joinedAt: '2026-11-15T12:00:00Z',
        lanes: [{ lane: 'claude', share: 50 }],
      }).success,
    ).toBe(true);
    expect(
      orgJoinRecordSchema.safeParse({
        v: 1,
        member: 'ada',
        machine: 'ada-mac',
        joinedAt: '2026-11-15T12:00:00Z',
        lanes: [{ lane: 'claude', share: 101 }],
      }).success,
    ).toBe(false);
  });
});

describe('org shared agent-plane helpers', () => {
  it('resolves org-plane storage paths, error messages, and undelivered ledger rows', () => {
    const paths = orgPlanePaths('/tmp/org-root');
    expect(paths).toEqual({
      anchor: resolve('/tmp/org-root'),
      dir: join(resolve('/tmp/org-root'), 'org'),
      file: join(resolve('/tmp/org-root'), 'org', 'agents.json'),
      lockFile: join(resolve('/tmp/org-root'), 'org', 'writer.lock'),
    });

    expect(() => refuseOrgStore('safe refusal')).toThrow(OrgStoreError);
    expect(orgStoreErrorMessage(new OrgStoreError('safe refusal'), 'fallback')).toBe('safe refusal');
    expect(orgStoreErrorMessage(new Error('raw /secret/path leak'), 'fallback')).toBe('fallback');

    const plane = {
      schema: 'org.agents.v1',
      storeId: '3f1c6a8e-2b7d-4e9a-8c51-0d2f7a9b6e10',
      revision: 2,
      agents: [],
      ledger: [
        { revision: 1, at: '2026-11-01T00:00:00.000Z', applied: true, busDelivered: true, edits: [], proposal: { actor: 'leader', reason: 'r1', expectedRevision: 0, change: { kind: 'retire', id: 'eng' } } },
        { revision: 2, at: '2026-11-02T00:00:00.000Z', applied: true, busDelivered: false, edits: [], proposal: { actor: 'leader', reason: 'r2', expectedRevision: 1, change: { kind: 'retire', id: 'eng' } } },
      ],
    } as OrgPlane;
    expect(undeliveredLedgerEntries(plane).map((row) => row.revision)).toEqual([2]);
  });

  it('parses fleet org-board and org-sync CLI flags strictly', () => {
    expect(parseOrgPlaneCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseOrgPlaneCliArgs(['--json', '-h'])).toEqual({ kind: 'help' });
    expect(parseOrgPlaneCliArgs(['--runs-dir', '/tmp/r', '--json'])).toEqual({
      kind: 'ok',
      json: true,
      apply: false,
      runsDir: '/tmp/r',
    });
    expect(parseOrgPlaneCliArgs(['--apply'])).toEqual({ kind: 'usage' });
    expect(parseOrgPlaneCliArgs(['--apply', '--json'], { allowApply: true })).toEqual({
      kind: 'ok',
      json: true,
      apply: true,
      runsDir: undefined,
    });
    for (const bad of [['--bogus'], ['--runs-dir'], ['--runs-dir', '--json'], ['--json', '--json'], ['--apply', '--apply']]) {
      expect(parseOrgPlaneCliArgs(bad, { allowApply: true })).toEqual({ kind: 'usage' });
    }
  });

  it('exports shared agent-plane schema primitives matching outbox and chart validation', () => {
    expect(ORG_PLANE_TIERS).toEqual(['LEADER', 'ORCHESTRATOR', 'WORKER_SESSION']);
    expect(ORG_PLANE_STATUSES).toEqual(['active', 'retired']);
    expect(orgPlaneIdSchema.safeParse('engineering').success).toBe(true);
    expect(orgPlaneIdSchema.safeParse('engineering\n').success).toBe(false);
    expect(orgPlaneNeedTokenSchema.safeParse('git.read').success).toBe(true);
    expect(orgPlaneNeedTokenSchema.safeParse('Git').success).toBe(false);
  });
});
