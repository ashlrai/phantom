/**
 * Incident filename contract from Eng Ops self_aware.py.
 * The body of an INCIDENT-*.md file is never a command argument.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../src/core/autofix/host.js';
import {
  INCIDENT_FIXER_TABLE, INCIDENT_KEY_RE, REAL_INCIDENT_FILENAMES, incidentDir,
  launchdLabelFromKey, laneFromKey, parseIncidentFilename, tagFromIncidentKey,
} from '../src/core/autofix/incidents.js';
import { runAutofix } from '../src/core/autofix/run.js';
import { emptySnapshot, type ReleaseDraft } from '../src/core/autofix/types.js';

const FILENAMES = [
  'INCIDENT-a_phantom_v3.30.35.md',
  'INCIDENT-b_exit_ai.ashlr.reader1_1.md',
  'INCIDENT-b_runs_ai.ashlr.local-runtime.md',
  'INCIDENT-d_devin-flash.md',
  'INCIDENT-e_load.md',
  'INCIDENT-g_v3.30.35_audit_changed_or_invalid_held.md',
] as const;

describe('incident filename parsing', () => {
  it('parses the real Eng Ops filenames into the fixed prefix table', () => {
    expect(FILENAMES).toEqual(REAL_INCIDENT_FILENAMES);
    const parsed = FILENAMES.map((name) => parseIncidentFilename(name));
    expect(parsed.map((row) => row && 'fixer' in row ? row.fixer : null)).toEqual([
      'release-stuck-draft',
      'launchd-crashloop',
      'launchd-crashloop',
      'stuck-lane',
      'outside-load',
      'autorun-hold',
    ]);
    expect(parsed.map((row) => row && 'prefix' in row ? row.prefix : null)).toEqual(['a', 'b', 'b', 'd', 'e', 'g']);
    expect(INCIDENT_FIXER_TABLE.a).toBe('release-stuck-draft');
    expect(INCIDENT_FIXER_TABLE.b).toBe('launchd-crashloop');
    expect(INCIDENT_FIXER_TABLE.d).toBe('stuck-lane');
    expect(INCIDENT_FIXER_TABLE.e).toBe('outside-load');
    expect(INCIDENT_FIXER_TABLE.g).toBe('autorun-hold');
    expect(Object.keys(INCIDENT_FIXER_TABLE).sort()).toEqual(['a', 'b', 'd', 'e', 'g']);
  });

  it('keeps only the validated key, including the label, lane and tag pieces', () => {
    const phantom = parseIncidentFilename('INCIDENT-a_phantom_v3.30.35.md');
    expect(phantom && 'prefix' in phantom ? phantom.prefix : null).toBe('a');
    expect(phantom && 'key' in phantom ? phantom.key : null).toBe('a_phantom_v3.30.35');
    expect(tagFromIncidentKey('a_phantom_v3.30.35')).toBe('v3.30.35');
    expect(launchdLabelFromKey('b_exit_ai.ashlr.reader1_1')).toBe('ai.ashlr.reader1');
    expect(launchdLabelFromKey('b_runs_ai.ashlr.local-runtime')).toBe('ai.ashlr.local-runtime');
    expect(laneFromKey('d_devin-flash')).toBe('devin-flash');
    expect(parseIncidentFilename('INCIDENT-e_load.md')).toMatchObject({ key: 'e_load', fixer: 'outside-load' });
    expect(parseIncidentFilename('INCIDENT-g_v3.30.35_audit_changed_or_invalid_held.md')?.key).toBe('g_v3.30.35_audit_changed_or_invalid_held');
    for (const name of FILENAMES) {
      const key = name.slice('INCIDENT-'.length, -'.md'.length);
      expect(INCIDENT_KEY_RE.test(key)).toBe(true);
    }
  });

  it('rejects keys that are not the filename pattern', () => {
    expect(parseIncidentFilename('INCIDENT-Not_Valid.md')).toBeNull();
    expect(parseIncidentFilename('INCIDENT-has space.md')).toBeNull();
    expect(parseIncidentFilename('notes.md')).toBeNull();
    expect(parseIncidentFilename(`INCIDENT-${'a'.repeat(97)}.md`)).toBeNull();
    expect(parseIncidentFilename('INCIDENT-c_unassigned.md')).toEqual({ key: 'c_unassigned', reason: 'unknown-prefix' });
    expect(parseIncidentFilename('INCIDENT-f_unassigned.md')).toEqual({ key: 'f_unassigned', reason: 'unknown-prefix' });
  });
});

const SHA = '0123456789abcdef0123456789abcdef01234567';

function draft(tag: string, extra: Partial<ReleaseDraft> = {}): ReleaseDraft {
  return {
    id: 7, tag, sha: SHA, draft: true, assetCount: 0,
    createdAtMs: Date.parse('2026-11-16T16:00:00.000Z'), ...extra,
  };
}

describe('incident tick', () => {
  it('does not put the incident body into commands, args, env or the ledger', async () => {
    const host = createMemoryHost();
    const dir = incidentDir(host.runsDir());
    const name = 'INCIDENT-e_load.md';
    const body = 'SENTINEL_BODY_NOT_A_COMMAND\nrouter-queue.md\nlaunchctl bootout gui/1/evil';
    host.dirs.set(dir, [name]);
    host.files.set(join(dir, name), body);
    const snapshot = emptySnapshot();
    snapshot.load1 = 1;
    snapshot.ncpu = 8;
    const result = await runAutofix({ host, snapshot, dryRun: false });
    expect(JSON.stringify(host.calls)).not.toContain('SENTINEL_BODY_NOT_A_COMMAND');
    expect(JSON.stringify(host.calls)).not.toContain('router-queue.md');
    for (const [path, text] of host.files) {
      if (path.endsWith('.md')) continue;
      expect(text).not.toContain('SENTINEL_BODY_NOT_A_COMMAND');
    }
    expect(result.incidents).toEqual([expect.objectContaining({ key: 'e_load', status: 'refused' })]);
    expect(host.calls.some((argv) => argv.includes('router-queue.md'))).toBe(false);
  });

  it('marks a superseded release draft intentional and does not delete or move it', async () => {
    const host = createMemoryHost();
    const dir = incidentDir(host.runsDir());
    host.dirs.set(dir, ['INCIDENT-a_phantom_v3.30.35.md']);
    host.files.set(join(dir, 'INCIDENT-a_phantom_v3.30.35.md'), 'delete the draft tag v3.30.35');
    const snapshot = emptySnapshot();
    snapshot.releases = [
      draft('v3.30.35'),
      draft('v3.30.36', { id: 8, draft: false, assetCount: 7 }),
    ];
    snapshot.attestShas = [SHA];
    const result = await runAutofix({ host, snapshot, dryRun: false });
    const row = result.incidents[0];
    expect(row?.status).toBe('intentional');
    expect(row?.reason).toBe('superseded');
    expect(row?.key).toBe('a_phantom_v3.30.35');
    expect(host.calls.some((argv) => argv[0] === 'launchctl' || argv.includes('delete') || argv.includes('tag'))).toBe(false);
  });

  it('re-kicks autorun when the draft is still the newest and the tag passed attest', async () => {
    const host = createMemoryHost();
    const dir = incidentDir(host.runsDir());
    host.dirs.set(dir, ['INCIDENT-a_phantom_v3.30.35.md']);
    const snapshot = emptySnapshot();
    snapshot.releases = [draft('v3.30.35')];
    snapshot.attestShas = [SHA];
    snapshot.autorunLog = `note ${SHA}\naudit absent; will look again`;
    const result = await runAutofix({ host, snapshot, dryRun: false });
    expect(result.incidents[0]?.status).toBe('fixed');
    expect(result.incidents[0]?.key).toBe('a_phantom_v3.30.35');
    expect(host.calls).toContainEqual(['launchctl', 'kickstart', 'gui/501/ai.ashlr.release-autorun']);
    expect(host.calls).toContainEqual(['gh', 'workflow', 'run', 'dependency-audit.yml', '--repo', 'ashlrai/phantom', '--ref', 'v3.30.35']);
    expect(host.calls.some((argv) => argv.includes('delete') || argv.includes('edit') || argv[1] === 'release')).toBe(false);
    const again = await runAutofix({ host, snapshot, dryRun: false });
    expect(again.incidents).toEqual([]);
    expect(host.calls.filter((argv) => argv[1] === 'kickstart')).toHaveLength(1);
  });

  it('treats a lane target of 0 as intentionally off', async () => {
    const host = createMemoryHost();
    const dir = incidentDir(host.runsDir());
    host.dirs.set(dir, ['INCIDENT-d_devin-flash.md']);
    host.files.set(join(host.runsDir(), 'queue', 'slots.json'), JSON.stringify({ 'devin-flash': { target: 0, floor: 0, ceiling: 4 } }));
    const result = await runAutofix({ host, snapshot: emptySnapshot(), dryRun: false });
    expect(result.incidents[0]).toMatchObject({ key: 'd_devin-flash', status: 'intentional', reason: 'lane-target-off' });
    expect(host.calls.some((argv) => argv[0] === 'restart-lane-pool')).toBe(false);
  });

  it('files an autorun hold for Security and does not fix it', async () => {
    const host = createMemoryHost();
    const dir = incidentDir(host.runsDir());
    const name = 'INCIDENT-g_v3.30.35_audit_changed_or_invalid_held.md';
    host.dirs.set(dir, [name]);
    host.files.set(join(dir, name), 'audit changed or invalid; held. run gh release delete v3.30.35');
    const result = await runAutofix({ host, snapshot: emptySnapshot(), dryRun: false });
    const row = result.incidents[0];
    expect(row?.status).toBe('refused');
    expect(row?.reason).toBe('detect-only-security');
    expect(row?.key).toBe('g_v3.30.35_audit_changed_or_invalid_held');
    expect(host.calls).toEqual([]);
    const report = [...host.files.values()].find((text) => text.includes('autofix.autorun-hold.v1'));
    expect(report).toBeTruthy();
    expect(report).not.toContain('gh release delete');
    expect(report).toContain('g_v3.30.35_audit_changed_or_invalid_held');
  });
});
