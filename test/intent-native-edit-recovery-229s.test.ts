import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { readLedger, intentLedgerPath } from '../src/core/intent/store.js';

// Recovered from PR #4516 (test/intent-native-edit-preservation-09sqa1.test.ts) against the
// registered native MCP dispatch path and the current edit/schema/store contracts. All
// directives, sources, owners and RQ keys are fake. The ledger root is the relocated
// process home (fixedOwnerRunsDir resolves there under Vitest); the kill switch is the
// real sentinel file, so no store, handler or safety boundary is stubbed.
let home = '';
let root = '';
let savedHome = '';
beforeEach(() => {
  savedHome = process.env['HOME'] ?? '';
  home = mkdtempSync(join(tmpdir(), 'intent-native-edit-229s-'));
  process.env['HOME'] = home;
  root = join(home, '.ashlr-runs');
});
afterEach(() => {
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});
const call = (name: string, args: unknown) => callNativeTool(name, args);

describe('native intent edit recovery (PR #4516)', () => {
  it('advertises closed append tools and keeps existing native tools', () => {
    const tools = listNativeTools();
    const names = tools.map(tool => tool.name);
    for (const name of ['intent_add', 'intent_update', 'intent_link', 'intent_ship', 'phantom_agent_bus_read']) {
      expect(names).toContain(name);
    }
    for (const name of ['intent_add', 'intent_update']) {
      expect(nativeToolSafety(name)).toBe('append');
      expect(tools.find(tool => tool.name === name)?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('creates, dedupes, revises and refuses through real dispatch with byte-preserving failures', async () => {
    const add = { title: 'Fake directive', source: 'fixture one', rq: ['RQ-FAKE-1'], verbatim: true };
    expect((await call('intent_add', add)).isError).toBeFalsy();
    const id = (await readLedger(root)).items[0]!.id;
    // Same normalized title merges: RQ keys union and provenance is appended.
    expect((await call('intent_add', { ...add, source: 'fixture two', rq: ['RQ-FAKE-2'] })).isError).toBeFalsy();
    // Caller evidence is tracking: it is recorded, never proof of verification.
    expect((await call('intent_update', { id, owner: 'fixture owner', rq: ['RQ-FAKE-3'], status: 'queued', evidence: 'fixture verification' })).isError).toBeFalsy();
    const ledger = await readLedger(root);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({
      owner: 'fixture owner', rq: ['RQ-FAKE-1', 'RQ-FAKE-2', 'RQ-FAKE-3'], status: 'queued',
      evidence: [{ kind: 'verification', ref: 'fixture verification' }],
    });
    expect(ledger.items[0]!.provenance.map(row => row.source)).toEqual(['fixture one', 'fixture two']);
    expect(statSync(intentLedgerPath(root)).mode & 0o777).toBe(0o600);

    const bytes = readFileSync(intentLedgerPath(root), 'utf8');
    for (const [name, args] of [
      ['intent_update', { id: 'int 0000000000000000' }],
      ['intent_update', { id: 'bad id!', owner: 'x' }],
      ['intent_update', { id, root: '/tmp' }],
      ['intent_update', { id, now: '2026-01-01T00:00:00Z' }],
      ['intent_update', { id, evidence: { ref: 'bad' } }],
      ['intent_update', { id, partial: 'yes' }],
      ['intent_update', { id, status: 'bad' }],
      ['intent_update', { id: 'missing-directive' }],
      ['intent_add', { ...add, rq: ['bad'] }],
      ['intent_add', { ...add, staleAfterMs: Infinity }],
      ['intent_add', { ...add, staleAfterMs: 1000 }],
      ['intent_add', { ...add, verbatim: 1 }],
      ['intent_add', { ...add, id: 'caller-supplied' }],
      ['intent_add', { source: 'fixture three' }],
      ['intent_add', { title: 'x'.repeat(301), source: 'fixture three' }],
      ['intent_add', null],
      ['intent_update', 'not-an-object'],
    ] as const) {
      expect((await call(name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(bytes);

    // The real kill-switch sentinel refuses both mutations and preserves bytes.
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n');
    expect((await call('intent_add', { title: 'Blocked', source: 'fixture' })).isError).toBe(true);
    expect((await call('intent_update', { id, owner: 'another' })).isError).toBe(true);
    expect(readFileSync(intentLedgerPath(root), 'utf8')).toBe(bytes);
  });
});
