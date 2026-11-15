// recheck history read outcome (RQ-PHX-RECHECKHISTORYREAD330S): a failed read
// of fleet/recheck-log.jsonl must never look like a successful empty read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import {
  readRecheckRecords, recheckLogPath, RECHECK_RECORD_SCHEMA,
  type ReadRecords, type RecheckRecord,
} from '../src/core/fleet/recheck-record.js';
import { readFleetRecheckHistoryTool } from '../src/mcp/fleet-recheck.js';
import { createFleetRecheckApi, VERSE_FLEET_RECHECK_PATH } from '../src/core/verse/fleet-recheck-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';

const dirs: string[] = [];
const tempRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'rr-outcome-')); dirs.push(d); return d; };
const savedAshlrHome = process.env.ASHLR_HOME;
afterEach(() => {
  vi.restoreAllMocks();
  if (savedAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = savedAshlrHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ISO = '2026-11-14T03:00:00.000Z';
function record(asOf: string): RecheckRecord {
  return {
    schema: RECHECK_RECORD_SCHEMA, asOf, overall: 'VERIFIED',
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '0.0.0-fake', asOf },
      claims: { state: 'VERIFIED', active: 1, asOf },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf },
      task: { state: 'VERIFIED', id: 'fake-task', owner: 'fake-owner', claimReceipt: 'bus-claim:fake:0:1', asOf },
      missing: null,
    },
  };
}
/** A directory at the log path makes readFileSync fail with EISDIR — a
 * deterministic non-ENOENT failure that needs no chmod or root privileges. */
function blockLogPath(root: string): void {
  mkdirSync(recheckLogPath(root), { recursive: true });
}

describe('readRecheckRecords outcome', () => {
  it('reports a fresh empty file as a successful empty read, distinct from absent', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'fleet'), { recursive: true });
    writeFileSync(recheckLogPath(root), '');
    const res = readRecheckRecords(root, 5);
    expect(res).toMatchObject({ rows: [], skipped: 0, missing: false, outcome: 'ok' });
    const absent = readRecheckRecords(tempRoot(), 5);
    expect(absent).toEqual({ rows: [], skipped: 0, missing: true });
    expect(absent.outcome).toBeUndefined();
  });

  it('reports ENOENT as absent with the legacy shape', () => {
    expect(readRecheckRecords(tempRoot(), 5)).toEqual({ rows: [], skipped: 0, missing: true });
  });

  it('reports a non-ENOENT read failure as unreadable with a safe code', () => {
    const root = tempRoot();
    blockLogPath(root);
    const res: ReadRecords = readRecheckRecords(root, 5);
    expect(res).toMatchObject({ rows: [], skipped: 0, missing: false, outcome: 'unreadable', failure: 'EISDIR' });
    expect(JSON.stringify(res)).not.toContain(root);
  });

  it('keeps valid rows newest-first and counts malformed lines as skipped', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'fleet'), { recursive: true });
    writeFileSync(recheckLogPath(root), `${JSON.stringify(record('2026-11-13T10:00:00.000Z'))}\nnot json\n${JSON.stringify(record(ISO))}\n`);
    const res = readRecheckRecords(root, 5);
    expect(res.outcome).toBe('ok');
    expect(res.skipped).toBe(1);
    expect(res.rows.map(r => r.asOf)).toEqual([ISO, '2026-11-13T10:00:00.000Z']);
  });
});

describe('fleet recheck-record --last on unreadable history', () => {
  it('--last --json exits nonzero with a sanitized diagnostic and no JSON array', async () => {
    const root = tempRoot();
    blockLogPath(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetRecheckRecord(['--last', '5', '--json'], { root })).toBe(1);
    expect(log).not.toHaveBeenCalled();
    const msg = err.mock.lastCall![0] as string;
    expect(msg).toMatch(/^recheck history unavailable/);
    expect(msg).not.toContain(root);
    expect(msg).not.toContain('/');
  });

  it('--last plain exits nonzero with the same safe diagnostic', async () => {
    const root = tempRoot();
    blockLogPath(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetRecheckRecord(['--last', '5'], { root })).toBe(1);
    expect(err.mock.lastCall![0]).toMatch(/^recheck history unavailable/);
  });

  it('keeps exit 0 with [] for --json on absent history and on a fresh empty file', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRecheckRecord(['--last', '5', '--json'], { root: tempRoot() })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('[]');
    const empty = tempRoot();
    mkdirSync(join(empty, 'fleet'), { recursive: true });
    writeFileSync(recheckLogPath(empty), '');
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '5', '--json'], { root: empty })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('[]');
  });
});

describe('API and MCP forwarding compatibility', () => {
  it('MCP fleet_recheck_history forwards the read outcome unchanged', async () => {
    const home = tempRoot();
    process.env.ASHLR_HOME = home;
    blockLogPath(home);
    const res = await readFleetRecheckHistoryTool({ last: 5 });
    expect(res).toMatchObject({ rows: [], skipped: 0, missing: false, outcome: 'unreadable' });
  });

  it('verse API keeps its pinned {rows, skipped, missing} projection on history reads', async () => {
    const home = tempRoot();
    blockLogPath(home);
    const verdict = { overall: { state: 'VERIFIED', missing: [] } } as unknown as FleetRecheck;
    const api: ApiModule = createFleetRecheckApi({ readRecheck: () => verdict, home: () => home });
    let status = 0;
    let text = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const handled = await api({} as VerseApiContext, { url: `${VERSE_FLEET_RECHECK_PATH}?history=5` } as IncomingMessage, res, VERSE_FLEET_RECHECK_PATH, 'GET');
    expect(handled).toBe(true);
    expect(status).toBe(200);
    // The API projects only the legacy fields its contract pins; the typed
    // outcome reaches agents through the CLI and the MCP tool's ReadRecords.
    expect(JSON.parse(text).history).toEqual({ rows: [], skipped: 0, missing: false });
  });
});
