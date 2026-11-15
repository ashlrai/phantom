import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DynConfigError,
  LIVE_CONFIG_AUDIT_FILE,
  LIVE_CONFIG_FILE,
  classifyKey,
  clearLiveOverride,
  createConfigReader,
  liveOverride,
  readConfigAudit,
  setLiveOverride,
} from '../src/core/fleet/dynconfig.js';
import { cmdFleetConfig } from '../src/cli/fleet-config.js';
import { parseLaneDiskLines } from '../src/cli/fleet-disk.js';

let runs: string;
let queue: string;
const T = (s: string) => () => new Date(`2026-11-15T${s}Z`);
const SLOTS = { hard_cap: 20, last_change_by: 'x', alpha: { target: 3, floor: 1, ceiling: 6 } };
const BUDGET = { compact: { lanes: { raise_freeze_below_gb: 50 } }, pool: { reading: 7 } };

beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), 'dynconfig-'));
  queue = join(runs, 'queue');
  await mkdir(queue, { recursive: true });
});
afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

const writeJson = (name: string, v: unknown) => writeFile(join(queue, name), JSON.stringify(v));
const by = 'tester';

describe('precedence: default < slots < budget < live < cli', () => {
  it('resolves each layer and reports provenance', async () => {
    await writeJson('slots.json', SLOTS);
    await writeJson('budget-overrides.json', BUDGET);
    const reader = createConfigReader({ runsDir: runs });
    let r = await reader.resolve();
    expect(r.values['compact.lanes.halve_below_gb']).toBe(35);
    expect(r.provenance['compact.lanes.halve_below_gb']!.layer).toBe('default');
    expect(r.values.hard_cap).toBe(20);
    expect(r.provenance.hard_cap!.layer).toBe('slots');
    expect(r.values['lanes.alpha.target']).toBe(3);
    expect(r.values['compact.lanes.raise_freeze_below_gb']).toBe(50);
    expect(r.provenance['compact.lanes.raise_freeze_below_gb']!.layer).toBe('budget');

    await setLiveOverride({ key: 'compact.lanes.raise_freeze_below_gb', value: 40, by, reason: 'disk pressure' }, { runsDir: runs, now: T('10:00:00') });
    await setLiveOverride({ key: 'hard_cap', value: 12, by, reason: 'shed load' }, { runsDir: runs });
    r = await reader.resolve();
    expect(r.values['compact.lanes.raise_freeze_below_gb']).toBe(40);
    expect(r.provenance['compact.lanes.raise_freeze_below_gb']).toMatchObject({ layer: 'live', by, at: '2026-11-15T10:00:00.000Z', reason: 'disk pressure' });
    expect(r.values.hard_cap).toBe(12);

    r = await reader.resolve({ 'compact.lanes.raise_freeze_below_gb': 25 });
    expect(r.values['compact.lanes.raise_freeze_below_gb']).toBe(25);
    expect(r.provenance['compact.lanes.raise_freeze_below_gb']!.layer).toBe('cli');
    // CLI layer is one-shot: not persisted.
    expect((await reader.resolve()).values['compact.lanes.raise_freeze_below_gb']).toBe(40);
  });

  it('unset reveals the lower layer again', async () => {
    await writeJson('budget-overrides.json', BUDGET);
    const o = { runsDir: runs };
    await setLiveOverride({ key: 'compact.lanes.raise_freeze_below_gb', value: 10, by, reason: 'r' }, o);
    await clearLiveOverride({ key: 'compact.lanes.raise_freeze_below_gb', by, reason: 'done' }, o);
    const r = await createConfigReader(o).resolve();
    expect(r.values['compact.lanes.raise_freeze_below_gb']).toBe(50);
    expect(r.provenance['compact.lanes.raise_freeze_below_gb']!.layer).toBe('budget');
  });

  it('is backward compatible: with no live file values equal the existing files', async () => {
    await writeJson('slots.json', SLOTS);
    await writeJson('budget-overrides.json', BUDGET);
    const r = await createConfigReader({ runsDir: runs }).resolve();
    expect(r.layers.live).toBe('missing');
    expect(r.rejected).toEqual([]);
    expect(Object.values(r.provenance).every(p => p.layer !== 'live' && p.layer !== 'cli')).toBe(true);
    expect(r.values['compact.lanes.raise_freeze_below_gb']).toBe(parseLaneDiskLines(JSON.stringify(BUDGET)).freezeBelowGb);
    await expect(liveOverride('compact.lanes.raise_freeze_below_gb', { runsDir: runs })).resolves.toBeUndefined();
  });
});

describe('mtime-triggered reload', () => {
  it('re-parses only when the file signature changes', async () => {
    await writeJson('slots.json', SLOTS);
    const reader = createConfigReader({ runsDir: runs });
    await reader.resolve();
    const first = reader.parses;
    await reader.resolve();
    await reader.resolve();
    expect(reader.parses).toBe(first);
    await setLiveOverride({ key: 'hard_cap', value: 9, by, reason: 'r' }, { runsDir: runs });
    expect((await reader.resolve()).values.hard_cap).toBe(9);
    expect(reader.parses).toBe(first + 1);
    // Same mtime, new content (rename gives a new inode) is still picked up.
    const path = join(queue, LIVE_CONFIG_FILE);
    const st = await import('node:fs/promises').then(m => m.stat(path));
    await setLiveOverride({ key: 'hard_cap', value: 8, by, reason: 'r2' }, { runsDir: runs });
    await utimes(path, st.atime, st.mtime);
    expect((await reader.resolve()).values.hard_cap).toBe(8);
  });
});

describe('atomicity', () => {
  it('a torn live file keeps the last good value and reports degraded', async () => {
    const o = { runsDir: runs };
    await setLiveOverride({ key: 'hard_cap', value: 9, by, reason: 'r' }, o);
    const reader = createConfigReader(o);
    expect((await reader.resolve()).values.hard_cap).toBe(9);
    await writeFile(join(queue, LIVE_CONFIG_FILE), '{"v":1,"overrides":{"hard_c');
    const r = await reader.resolve();
    expect(r.layers.live).toBe('degraded');
    expect(r.values.hard_cap).toBe(9);
    // The writer refuses to clobber a corrupt file.
    await expect(setLiveOverride({ key: 'hard_cap', value: 3, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readFile(join(queue, LIVE_CONFIG_FILE), 'utf8')).toBe('{"v":1,"overrides":{"hard_c');
  });

  it('concurrent writers never lose an update or leave temp/lock files', async () => {
    const o = { runsDir: runs };
    const keys = Array.from({ length: 12 }, (_, i) => `lanes.lane-${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}.hard_cap`);
    await Promise.all(keys.map((key, i) => setLiveOverride({ key, value: i, by, reason: 'burst' }, o)));
    const live = JSON.parse(await readFile(join(queue, LIVE_CONFIG_FILE), 'utf8'));
    expect(Object.keys(live.overrides).sort()).toEqual([...keys].sort());
    const audit = await readConfigAudit(o);
    expect(audit.entries).toHaveLength(12);
    expect(audit.malformedLines).toBe(0);
    expect((await readdir(queue)).filter(f => f.startsWith('.live-config'))).toEqual([]);
  });

  it('readers racing a writer only ever see complete files', async () => {
    const o = { runsDir: runs };
    await setLiveOverride({ key: 'hard_cap', value: 1, by, reason: 'seed' }, o);
    const seen = new Set<number>();
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        const text = await readFile(join(queue, LIVE_CONFIG_FILE), 'utf8');
        seen.add(JSON.parse(text).overrides.hard_cap.value); // throws on a torn file
      }
    })();
    for (let i = 2; i < 30; i++) await setLiveOverride({ key: 'hard_cap', value: i, by, reason: 'spin' }, o);
    stop = true;
    await reader;
    expect(seen.size).toBeGreaterThan(0);
  });

  it('refuses the change when the audit sink is a symlink (no unaudited writes)', async () => {
    const o = { runsDir: runs };
    await writeFile(join(runs, 'elsewhere'), '');
    await symlink(join(runs, 'elsewhere'), join(queue, LIVE_CONFIG_AUDIT_FILE));
    await expect(setLiveOverride({ key: 'hard_cap', value: 1, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(readFile(join(queue, LIVE_CONFIG_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers from a stale lock left by a crashed writer', async () => {
    const lock = join(queue, '.live-config.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await setLiveOverride({ key: 'hard_cap', value: 4, by, reason: 'r' }, { runsDir: runs });
    expect((await createConfigReader({ runsDir: runs }).resolve()).values.hard_cap).toBe(4);
  });
});

describe('audit trail', () => {
  it('records who/when/why for set and unset and extends last_change_by', async () => {
    const o = { runsDir: runs };
    await setLiveOverride({ key: 'hard_cap', value: 10, by: 'lane:claude', reason: 'load spike', }, { ...o, now: T('11:00:00') });
    await clearLiveOverride({ key: 'hard_cap', by: 'owner', reason: 'spike over' }, { ...o, now: T('11:30:00') });
    const rep = await readConfigAudit(o);
    expect(rep.schema).toBe('fleet.config.audit.v1');
    expect(rep.last_change_by).toBe('owner 2026-11-15T11:30:00.000Z');
    expect(rep.active).toEqual([]);
    expect(rep.entries).toEqual([
      { v: 1, at: '2026-11-15T11:00:00.000Z', op: 'set', key: 'hard_cap', from: null, to: 10, by: 'lane:claude', reason: 'load spike' },
      { v: 1, at: '2026-11-15T11:30:00.000Z', op: 'unset', key: 'hard_cap', from: 10, to: null, by: 'owner', reason: 'spike over' },
    ]);
  });

  it('requires a reason and an actor; strips control characters', async () => {
    const o = { runsDir: runs };
    await expect(setLiveOverride({ key: 'hard_cap', value: 1, by, reason: '  ' }, o)).rejects.toMatchObject({ code: 'invalid-reason' });
    await expect(setLiveOverride({ key: 'hard_cap', value: 1, by: '', reason: 'r' }, o)).rejects.toMatchObject({ code: 'invalid-reason' });
    await setLiveOverride({ key: 'hard_cap', value: 1, by: 'a\nb', reason: 'x\ty\r\nz' }, o);
    const [e] = (await readConfigAudit(o)).entries;
    expect(e).toMatchObject({ by: 'a b', reason: 'x y  z' });
    expect((await readFile(join(queue, LIVE_CONFIG_AUDIT_FILE), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('missing state and malformed lines are reported, not thrown', async () => {
    expect((await readConfigAudit({ runsDir: runs })).state).toBe('missing');
    await writeFile(join(queue, LIVE_CONFIG_AUDIT_FILE), 'not json\n');
    expect((await readConfigAudit({ runsDir: runs })).malformedLines).toBe(1);
  });

  it('`phm fleet config audit --json` emits the report', async () => {
    await setLiveOverride({ key: 'hard_cap', value: 10, by, reason: 'why' }, { runsDir: runs });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetConfig(['audit', '--json', '--runs-dir', runs])).toBe(0);
      const out = JSON.parse(String(log.mock.calls[0]![0]));
      expect(out.entries[0]).toMatchObject({ key: 'hard_cap', by, reason: 'why' });
      expect(out.active[0]).toMatchObject({ key: 'hard_cap', value: 10, reason: 'why' });
    } finally { log.mockRestore(); }
  });
});

describe('restart-required keys are never runtime-mutable', () => {
  const never = [
    'security.pin', 'pins.release', 'paid_models', 'paid.model.block', 'blocked_models', 'lanes.alpha.paid_block',
    'credentials.path', 'token_file', 'api_key', 'keychain.dir', 'secrets.root', 'GATES', 'gates.merge', 'merge_gates.file',
    'compact.lanes.credential_path',
  ];
  it.each(never)('classifies %s as restart-required', key => {
    expect(classifyKey(key)).toMatchObject({ ok: false, code: 'restart-required' });
  });

  it('writer refuses them (set and unset) and writes nothing', async () => {
    const o = { runsDir: runs };
    for (const key of never) {
      await expect(setLiveOverride({ key, value: 1, by, reason: 'r' }, o)).rejects.toBeInstanceOf(DynConfigError);
      await expect(setLiveOverride({ key, value: 1, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'restart-required' });
      await expect(clearLiveOverride({ key, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'restart-required' });
    }
    expect(await readdir(queue)).toEqual([]);
  });

  it('resolver ignores hand-edited restart-required entries and a CLI override of them', async () => {
    await writeJson(LIVE_CONFIG_FILE, { v: 1, last_change_by: '', overrides: {
      'security.pin': { value: 0, by: 'x', at: 'y', reason: 'z' },
      'hard_cap': { value: 7, by: 'x', at: 'y', reason: 'z' },
    } });
    const r = await createConfigReader({ runsDir: runs }).resolve({ 'gates.merge': 1 });
    expect(r.values.hard_cap).toBe(7);
    expect(r.values['security.pin']).toBeUndefined();
    expect(r.values['gates.merge']).toBeUndefined();
    expect(r.rejected.map(x => `${x.layer}:${x.key}`).sort()).toEqual(['cli:gates.merge', 'live:security.pin']);
  });

  it('unknown keys and out-of-range values are refused', async () => {
    const o = { runsDir: runs };
    await expect(setLiveOverride({ key: 'nope', value: 1, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'unknown-key' });
    await expect(setLiveOverride({ key: 'hard_cap', value: -1, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'invalid-value' });
    await expect(setLiveOverride({ key: 'hard_cap', value: 1.5, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'invalid-value' });
    await expect(setLiveOverride({ key: 'hard_cap', value: '3', by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'invalid-value' });
    await expect(setLiveOverride({ key: 'lanes.__proto__.target', value: 1, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'unknown-key' });
  });

  it('keeps lane bounds coherent against effective sibling values', async () => {
    await writeJson('slots.json', SLOTS);
    const o = { runsDir: runs };
    await expect(setLiveOverride({ key: 'lanes.alpha.target', value: 9, by, reason: 'r' }, o)).rejects.toMatchObject({ code: 'invalid-value' });
    await setLiveOverride({ key: 'lanes.alpha.target', value: 5, by, reason: 'r' }, o);
    expect((await createConfigReader(o).resolve()).values['lanes.alpha.target']).toBe(5);
  });

  it('CLI exits 2 on a restart-required set and lists the refused categories', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetConfig(['set', 'security.pin', '1', '--reason', 'x', '--runs-dir', runs])).toBe(2);
      expect(String(err.mock.calls[0]![0])).toContain('restart-required');
      expect(await cmdFleetConfig(['restart-required', '--json'])).toBe(0);
      const out = JSON.parse(String(log.mock.calls.at(-1)![0]));
      expect(out.restartRequired.map((r: { category: string }) => r.category)).toEqual(['security-pins', 'paid-model-blocks', 'credential-paths', 'gates-files']);
    } finally { err.mockRestore(); log.mockRestore(); }
  });
});

describe('existing readers overlay live overrides', () => {
  it('fleet disk lane lines honor a live override and fall back unchanged without one', async () => {
    const { readFleetDisk } = await import('../src/cli/fleet-disk.js');
    await writeJson('budget-overrides.json', { compact: { lanes: { raise_freeze_below_gb: 50, halve_below_gb: 30 } } });
    const deps = { runsRoot: runs, du: async () => '', readEvents: async () => ({ state: 'healthy' as const, text: '' }) };
    const before = await readFleetDisk(deps);
    expect(before).toMatchObject({ laneFreezeBelowGb: 50, laneHalveBelowGb: 30 });
    await setLiveOverride({ key: 'compact.lanes.halve_below_gb', value: 20, by, reason: 'r' }, { runsDir: runs });
    const after = await readFleetDisk(deps);
    expect(after).toMatchObject({ laneFreezeBelowGb: 50, laneHalveBelowGb: 20 });
  });
});
