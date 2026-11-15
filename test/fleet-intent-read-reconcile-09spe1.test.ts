import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetIntentRead } from '../src/cli/fleet-intent-read.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const date = '2026-11-05T00:00:00.000Z';
const record = (id: string, status: 'queued' | 'merged') => ({
  id, title: `Directive ${id}`, source: 'synthetic', owner: 'owner', rq: ['RQ-TEST-1'],
  prs: [{ repo: 'example/repo', number: 1, state: 'merged' }], status,
  evidence: [{ at: date, kind: 'pr', ref: 'example/repo#1' }],
  provenance: [{ source: 'synthetic original', date, verbatim: true, partial: false }],
  partial: false, closureProposal: null, lastTouchedAt: date, staleAfterMs: 1000, createdAt: date, updatedAt: date,
});
const items = [record('first', 'queued'), record('second', 'merged')];
let root: string;
let original: string | undefined;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

async function run(...args: string[]) {
  log.mockClear(); error.mockClear();
  const code = await cmdFleetIntentRead(args);
  return { code, out: log.mock.calls.map(call => String(call[0])).join('\n'), err: error.mock.calls.map(call => String(call[0])).join('\n') };
}

describe('fleet intent read', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intent-read-'));
    original = process.env['ASHLR_RUNS_DIR']; process.env['ASHLR_RUNS_DIR'] = root;
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    if (original === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = original;
    vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
  });
  it('lists and retrieves complete records without modifying the ledger', async () => {
    const path = join(root, 'intent', 'ledger.json');
    await mkdir(join(root, 'intent'));
    const bytes = ` ${JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items })}\n`;
    await writeFile(path, bytes);
    expect(JSON.parse((await run('list', '--json')).out)).toEqual({ ok: true, records: items });
    expect(JSON.parse((await run('list', '--status', 'merged', '--json')).out)).toEqual({ ok: true, records: [items[1]] });
    expect(JSON.parse((await run('get', 'first', '--json')).out)).toEqual({ ok: true, item: items[0] });
    expect((await run('get', 'first')).out).toContain('first  [queued]  Directive first');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
  it('handles absent, missing, malformed and unreadable ledgers explicitly', async () => {
    expect(JSON.parse((await run('list', '--json')).out)).toEqual({ ok: true, records: [] });
    expect((await run('get', 'missing', '--json')).code).not.toBe(0);
    await mkdir(join(root, 'intent'));
    const path = join(root, 'intent', 'ledger.json');
    await writeFile(path, 'private invalid content');
    const malformed = await run('list', '--json');
    expect(malformed.code).not.toBe(0);
    expect(malformed.out).not.toContain('private invalid content');
    await rm(path); await mkdir(path);
    expect((await run('list', '--json')).code).not.toBe(0);
  });
  it('rejects invalid arguments and exposes help and the generated loader', async () => {
    for (const args of [[], ['list', 'extra'], ['get'], ['get', '../bad'], ['get', 'one', 'two'], ['list', '--status', 'bad'], ['list', '--status', 'queued', '--status', 'merged'], ['list', '--json', '--json'], ['get', 'one', '--status', 'queued'], ['list', '--unknown'], ['list', '-x']]) {
      expect((await run(...args)).code, args.join(' ')).not.toBe(0);
    }
    expect((await run('--help')).out).toContain('ASHLR_RUNS_DIR');
    expect((await FLEET_SUBCOMMAND_LOADERS['intent-read']!())['cmdFleetIntentRead']).toBe(cmdFleetIntentRead);
  });
});
