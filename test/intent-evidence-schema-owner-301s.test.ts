/**
 * RQ-PHX-INTENTSCHEMAOWNER301S — executable qualification for EXISTING owner
 * PR #5263 (RQ-PHX-INTENTSCHEMAEXACT206S, observed head
 * 16f46c7909ce59cc511d3db6fbda36d7ee15f1dc). The owner makes tools/list
 * advertise the shared EVIDENCE_SCHEMAS objects from
 * src/core/intent/mcp-evidence.ts (identity, not copies) and checks ledger
 * presence before reading it in recordEvidence. The owner's own suite
 * test/intent-schema-exact-206s.test.ts exists only on the PR head, not on
 * master, so this file maps every one of its cases onto current executable
 * evidence.
 *
 * Added here (not already executed on master):
 *  - the advertised inputSchema DEEP-EQUALS the shared definitions today —
 *    source presence is not execution: master's inline literals match
 *    EVIDENCE_SCHEMAS structurally but are distinct objects until #5263 lands;
 *  - every advertised property (branch/url on intent_link, notes on
 *    intent_ship) is accepted by the real callNativeTool dispatch and the
 *    supplied values reach the ledger;
 *  - one link→ship pass leaves status shipped, closureProposal null and
 *    exactly {pr, release} evidence with no verification row.
 *
 * Self-skips until #5263 merges (the catalog then advertises the shared
 * objects themselves):
 *  - inputSchema IDENTITY (toBe) for both tools — the owner's headline case;
 *  - a non-regular ledger path reports 'Intent ledger unavailable.' on both
 *    tools, which master's readLedger-first order answers with the generic
 *    'Intent evidence could not be recorded.' instead.
 *
 * Already-covered original cases stay preserved by exact citation, not cloned:
 *  - unknown-field rejection with a byte-identical ledger →
 *    test/intent-native-evidence-recovery-183.test.ts
 *    'leaves unmatched calls and every malformed call byte-for-byte unchanged'
 *    and test/intent-mcp-evidence-recovery-150.test.ts
 *    'rejects malformed or extra fields without mutating the ledger';
 *  - absent-ledger refusal without file creation → 183
 *    'refuses secret-shaped metadata and corrupt or missing ledgers without
 *    echoing caller input' + 'reports an absent ledger as unavailable and does
 *    not create one' and 150 'does not fabricate success or create a ledger
 *    when none exists'.
 * All repos, PR numbers, RQ keys, URLs and releases are fake fixtures.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools } from '../src/core/mcp-native.js';
import { EVIDENCE_SCHEMAS } from '../src/core/intent/mcp-evidence.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-05T21:46:00.000Z';
const item: IntentItem = {
  id: 'alpha', title: 'alpha', source: 'fixture', owner: 'fixture', rq: ['RQ-ALPHA-1'], prs: [], status: 'queued',
  evidence: [], provenance: [{ source: 'fixture', date: null, verbatim: true, partial: false }], partial: false,
  closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
};
const TOOLS = ['intent_link', 'intent_ship'] as const;
// Master's catalog still carries inline literals: deep-equal today, identical
// only once PR #5263 advertises the shared EVIDENCE_SCHEMAS objects themselves.
const SHARED_IDENTITY = TOOLS.every(
  (name) => listNativeTools().find((tool) => tool.name === name)?.inputSchema === EVIDENCE_SCHEMAS[name],
);

let root = '';
const previousRuns = process.env['ASHLR_RUNS_DIR'];
const previousHome = process.env['HOME'];
afterEach(async () => {
  if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});
async function setup(seed = true): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-evidence-schema-301s-'));
  process.env['HOME'] = root;
  process.env['ASHLR_RUNS_DIR'] = root;
  if (seed) await writeLedger({ ...emptyLedger(), items: [item] }, root);
}

describe('intent evidence advertised schemas (current master contract)', () => {
  it('tools/list schemas deep-equal the shared EVIDENCE_SCHEMAS and pin the required sets', () => {
    const listed = listNativeTools();
    for (const name of TOOLS) {
      const advertised = listed.find((tool) => tool.name === name)?.inputSchema as
        | { required?: readonly string[]; additionalProperties?: boolean }
        | undefined;
      expect(advertised).toEqual(EVIDENCE_SCHEMAS[name]);
      expect(advertised?.['additionalProperties']).toBe(false);
      expect(advertised?.['required']).toEqual(EVIDENCE_SCHEMAS[name].required);
    }
    expect(EVIDENCE_SCHEMAS.intent_link.required).toEqual(['repo', 'number', 'title']);
    expect(EVIDENCE_SCHEMAS.intent_ship.required).toEqual(['release']);
  });

  it('accepts every advertised property through the real dispatch and stores the supplied evidence', async () => {
    await setup();
    const linked = await callNativeTool('intent_link', {
      repo: 'example/project', number: 7, title: 'RQ-ALPHA-1',
      branch: 'fix/alpha', url: 'https://example.invalid/pull/7', at,
    });
    expect(linked.isError).not.toBe(true);
    const shipped = await callNativeTool('intent_ship', {
      release: 'v0.0.1', notes: 'claimed by caller', rq: ['RQ-ALPHA-1'], at,
    });
    expect(shipped.isError).not.toBe(true);
    const [row] = (await readLedger(root)).items;
    expect(row!.prs).toEqual([{ repo: 'example/project', number: 7, url: 'https://example.invalid/pull/7', state: 'merged' }]);
    expect(row!.evidence.map((entry) => `${entry.kind}:${entry.ref}`)).toEqual(['pr:example/project#7', 'release:v0.0.1']);
  });

  it('a valid link then ship leaves shipped status, null closure and exactly pr+release evidence', async () => {
    await setup();
    expect((await callNativeTool('intent_link', { repo: 'example/project', number: 7, title: 'RQ-ALPHA-1', at })).isError).not.toBe(true);
    expect((await callNativeTool('intent_ship', { release: 'v0.0.1', rq: ['RQ-ALPHA-1'], notes: 'claimed by caller', at })).isError).not.toBe(true);
    const [row] = (await readLedger(root)).items;
    expect(row!.status).toBe('shipped');
    expect(row!.closureProposal).toBeNull();
    expect(row!.evidence.map((entry) => entry.kind).sort()).toEqual(['pr', 'release']);
    expect(row!.evidence.some((entry) => entry.kind === 'verification')).toBe(false);
  });
});

describe.skipIf(!SHARED_IDENTITY)('intent evidence shared-schema owner contract (PR #5263)', () => {
  it('tools/list advertises the shared EVIDENCE_SCHEMAS objects, not copies', () => {
    const listed = listNativeTools();
    for (const name of TOOLS) {
      expect(listed.find((tool) => tool.name === name)?.inputSchema).toBe(EVIDENCE_SCHEMAS[name]);
    }
  });

  it('reports a non-regular ledger path as unavailable on both tools', async () => {
    await setup(false);
    await mkdir(intentLedgerPath(root), { recursive: true });
    for (const [name, args] of [
      ['intent_link', { repo: 'example/project', number: 1, title: 'x' }],
      ['intent_ship', { release: 'v1', notes: 'n' }],
    ] as const) {
      const result = await callNativeTool(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('Intent ledger unavailable.');
    }
  });
});
