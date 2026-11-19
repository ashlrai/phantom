/**
 * Recovery of the read-only org board from PR #5809 (head 57bd29084a9359e13cad8a55db44fa43cb8aa2bd).
 * Drives the real exported CLI handler against the real safe file reader on temp directories.
 * No provider calls, no Slack sends, no runtime installation, and nothing under the real HOME.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORG_STORE_MAX_BYTES, orgBoardView, readAgentPlane } from '../src/core/org/agent-plane-reader.js';
import { cmdFleetOrgBoard, ORG_BOARD_USAGE } from '../src/cli/fleet-org-board.js';

const leader = {
  id: 'leader', title: 'CEO / digital cofounder', charter: 'Board-facing strategy.', tier: 'LEADER', reportsTo: null,
  status: 'active', scope: 'research', needs: [], laneAffinities: [],
  budget: { tokens: 0, sessions: 0, maxCostClass: 'included' }, sizing: { batchDepth: 100, fanOut: 0 }, sessionId: null,
};
const engineering = {
  ...leader, id: 'engineering', title: 'Engineering orchestrator', tier: 'ORCHESTRATOR', reportsTo: 'leader', scope: 'engineering', needs: ['git'],
};
const janitor = { ...engineering, id: 'janitor', title: 'JANITOR orchestrator', scope: 'janitor' };
const store = (over: Record<string, unknown> = {}) => ({
  schema: 'org.agents.v1', storeId: '3f1c6a8e-2b7d-4e9a-8c51-0d2f7a9b6e10', revision: 2,
  agents: [leader, engineering],
  ledger: [
    { revision: 1, at: '2026-11-01T00:00:00.000Z', applied: true, busDelivered: true, edits: [],
      proposal: { actor: 'leader', reason: 'Stand up engineering.', expectedRevision: 0, change: { kind: 'upsert', role: engineering } } },
    { revision: 2, at: '2026-11-02T00:00:00.000Z', applied: false, busDelivered: false, edits: [],
      proposal: { actor: 'leader', reason: 'Add janitor.', expectedRevision: 1, change: { kind: 'upsert', role: janitor } } },
  ],
  ...over,
});

let root: string;
let outside: string | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'org-board-621s-')); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (outside) rmSync(outside, { recursive: true, force: true });
  outside = undefined;
});

function writeStore(body: string, base = root): string {
  mkdirSync(join(base, 'org'), { recursive: true });
  const file = join(base, 'org', 'agents.json');
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

async function run(args: string[], defaultRunsRoot?: () => string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdFleetOrgBoard(args, { out: line => out.push(line), err: line => err.push(line), defaultRunsRoot });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Every entry under dir with its type, size, and content digest; detects any write, create, or delete. */
function fingerprint(dir: string): string[] {
  const entries: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      const stat = lstatSync(full);
      const digest = stat.isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : '';
      entries.push(`${full.slice(dir.length)} ${stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'} ${stat.size} ${digest}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries;
}

describe('org board CLI (fleet org-board)', () => {
  it('projects a valid store with the source semantics and never grants execution authority', async () => {
    writeStore(JSON.stringify(store()));
    const before = fingerprint(root);
    const result = await run(['--runs-dir', root, '--json']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const view = JSON.parse(result.out);
    expect(view).toMatchObject({
      schema: 'org.board.v1', revision: 2, board: 'Mason', grantsExecutionAuthority: false,
      provenance: 'persisted-planning-metadata', liveStaffing: 'unknown', pendingBusEvents: 1,
    });
    expect(view.agents.map((role: { id: string }) => role.id)).toEqual(['leader', 'engineering']);
    expect(view.pendingProposals).toHaveLength(1);
    expect(view.pendingProposals[0]).toMatchObject({ revision: 2, applied: false, proposal: { reason: 'Add janitor.' } });
    expect(view.recentEdits.map((row: { revision: number }) => row.revision)).toEqual([1]);
    expect(fingerprint(root)).toEqual(before);
  });

  it('prints a human summary that names the planning-metadata provenance and pending counts', async () => {
    writeStore(JSON.stringify(store()));
    const result = await run(['--runs-dir', root]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('org board org.board.v1 revision 2');
    expect(result.out).toContain('persisted planning metadata; live staffing unknown; grantsExecutionAuthority false');
    expect(result.out).toContain('engineering ORCHESTRATOR active reports to leader: Engineering orchestrator');
    expect(result.out).toContain('pending proposals (1):');
    expect(result.out).toContain('rev 2 by leader (upsert): Add janitor.');
    expect(result.out).toContain('pending bus events: 1');
  });

  it('uses the injected default runs root when --runs-dir is absent', async () => {
    writeStore(JSON.stringify(store()));
    const result = await run(['--json'], () => root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).revision).toBe(2);
  });

  it('reports absent storage as unavailable and never synthesizes or creates a board', async () => {
    const before = fingerprint(root);
    const result = await run(['--runs-dir', root, '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      schema: 'org.board.unavailable.v1', status: 'unavailable', grantsExecutionAuthority: false, liveStaffing: 'unknown',
      reason: 'Org store absent: no persisted planning metadata; live staffing is unknown.',
    });
    expect(existsSync(join(root, 'org'))).toBe(false);
    expect(fingerprint(root)).toEqual(before);
    expect(() => readAgentPlane(root)).toThrow('Org store absent');
  });

  it('refuses malformed JSON without echoing the private input or the path', async () => {
    writeStore('{"PRIVATE-MARKER-621S": ');
    const result = await run(['--runs-dir', root]);
    expect(result.code).toBe(1);
    expect(result.err).toBe('phm fleet org-board: Invalid org store: malformed JSON.');
    expect(result.out + result.err).not.toContain('PRIVATE-MARKER-621S');
    expect(result.out + result.err).not.toContain(root);
  });

  it.each([
    ['an invalid hierarchy', store({ agents: [leader, { ...engineering, reportsTo: 'ghost' }] }), 'Invalid org store: Invalid reporting tier or inactive parent.'],
    ['a second leader', store({ agents: [leader, { ...leader, id: 'other' }] }), 'Invalid org store: One active leader is required.'],
    ['a revision that disagrees with the ledger', store({ revision: 5 }), 'Invalid org ledger.'],
    ['a ledger entry out of order', store({ ledger: [store().ledger[1], store().ledger[0]] }), 'Invalid org ledger.'],
    ['an unknown top-level key', store({ extra: 'PRIVATE-EXTRA-621S' }), 'Invalid org store: Invalid org metadata; check the documented schema.'],
  ])('refuses %s with a bounded message', async (_label, body, reason) => {
    writeStore(JSON.stringify(body));
    const result = await run(['--runs-dir', root]);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`phm fleet org-board: ${reason}`);
    expect(result.out + result.err).not.toContain('PRIVATE-EXTRA-621S');
  });

  it('refuses oversized storage before parsing it, leaving the file untouched', async () => {
    const file = writeStore('x'.repeat(ORG_STORE_MAX_BYTES + 1));
    const before = fingerprint(root);
    const result = await run(['--runs-dir', root, '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).reason).toBe('Org store too large.');
    expect(readFileSync(file, 'utf8').length).toBe(ORG_STORE_MAX_BYTES + 1);
    expect(fingerprint(root)).toEqual(before);
  });

  it('refuses a symlinked org directory that escapes the runs root and leaves the target unchanged', async () => {
    outside = mkdtempSync(join(tmpdir(), 'org-board-621s-outside-'));
    writeStore(JSON.stringify(store()), outside);
    rmSync(join(root, 'org'), { recursive: true, force: true });
    symlinkSync(join(outside, 'org'), join(root, 'org'));
    const outsideBefore = fingerprint(outside);
    const rootBefore = fingerprint(root);
    const result = await run(['--runs-dir', root, '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).reason).toBe('Org store refused: unsafe path.');
    expect(fingerprint(outside)).toEqual(outsideBefore);
    expect(fingerprint(root)).toEqual(rootBefore);
  });

  it('refuses a symlinked agents.json file rather than following it', async () => {
    outside = mkdtempSync(join(tmpdir(), 'org-board-621s-outside-'));
    const target = join(outside, 'agents.json');
    writeFileSync(target, JSON.stringify(store()), { mode: 0o600 });
    mkdirSync(join(root, 'org'));
    symlinkSync(target, join(root, 'org', 'agents.json'));
    const before = fingerprint(root);
    const result = await run(['--runs-dir', root]);
    expect(result.code).toBe(1);
    expect(result.err).toBe('phm fleet org-board: Org store refused: unsafe file.');
    expect(fingerprint(root)).toEqual(before);
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(store()));
  });

  it('prints usage and exits 0 for help, and exits 2 for argument errors without touching storage', async () => {
    writeStore(JSON.stringify(store()));
    const before = fingerprint(root);
    for (const flag of ['--help', '-h']) {
      const help = await run([flag]);
      expect(help).toEqual({ code: 0, out: ORG_BOARD_USAGE, err: '' });
    }
    expect(ORG_BOARD_USAGE).toContain('Usage: phm fleet org-board [--runs-dir DIR] [--json]');
    for (const args of [['--bogus'], ['--runs-dir'], ['--runs-dir', '--json'], ['--json', '--json'], ['--runs-dir', root, 'extra']]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.err).toBe(ORG_BOARD_USAGE);
      expect(result.out).toBe('');
    }
    expect(fingerprint(root)).toEqual(before);
  });
});

describe('org board projection', () => {
  it('matches the source projection for a parsed plane', () => {
    writeStore(JSON.stringify(store()));
    const plane = readAgentPlane(root);
    const view = orgBoardView(plane);
    expect(view.pendingBusEvents).toBe(1);
    expect(view.pendingProposals.map(row => row.revision)).toEqual([2]);
    expect(view.recentEdits.map(row => row.revision)).toEqual([1]);
    expect(view.grantsExecutionAuthority).toBe(false);
  });
});
