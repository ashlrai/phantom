import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultStewardPolicy, runSteward } from '../src/core/steward/disk.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});

let sandbox: string;
let home: string;
const now = Date.now();
function oldFile(path: string, contents = 'private sandbox log'): string {
  fs.mkdirSync(join(path, '..'), { recursive: true });
  fs.writeFileSync(path, contents);
  const then = (now - 60 * 86_400_000) / 1000;
  fs.utimesSync(path, then, then);
  return path;
}
beforeEach(() => {
  sandbox = fs.mkdtempSync(join(process.cwd(), '.steward-boundary-'));
  home = join(sandbox, 'home');
  fs.mkdirSync(home);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('steward filesystem admission', () => {
  it('refuses arbitrary custom roots even below home', () => {
    const precious = oldFile(join(home, 'documents/private/keep.txt'));
    const policy = defaultStewardPolicy(home);
    policy.roots = [{ id: 'custom', path: join(home, 'documents/private'), action: 'delete', retentionDays: 0, quotaMB: 0 }];
    const report = runSteward(policy, { home, now, apply: true });
    expect(fs.readFileSync(precious, 'utf8')).toBe('private sandbox log');
    expect(report.deleted.files).toBe(0);
    expect(report.totalBytes).toBe(0);
  });

  it.each(['root', 'ancestor'])('does not traverse a symlink at the %s of an allowlisted root', (kind) => {
    const outside = oldFile(join(sandbox, 'outside/keep.txt'));
    if (kind === 'root') {
      fs.mkdirSync(join(home, '.ashlr'));
      fs.symlinkSync(join(sandbox, 'outside'), join(home, '.ashlr/logs'));
    } else {
      fs.mkdirSync(join(sandbox, 'outside/logs'));
      oldFile(join(sandbox, 'outside/logs/keep.txt'));
      fs.symlinkSync(join(sandbox, 'outside'), join(home, '.ashlr'));
    }
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.existsSync(outside)).toBe(true);
    expect(report.totalBytes).toBe(0);
    expect(report.deleted.files).toBe(0);
  });

  it('does not permit custom delete actions on vendor session roots', () => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'));
    const policy = defaultStewardPolicy(home);
    policy.roots[0].action = 'delete';
    const report = runSteward(policy, { home, now, apply: true });
    expect(fs.existsSync(session)).toBe(true);
    expect(report.deleted.files).toBe(0);
  });

  it('refuses a forged root id that could escape the archive directory', () => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'));
    const policy = defaultStewardPolicy(home);
    policy.roots[0].id = '../../elsewhere';
    const report = runSteward(policy, { home, now, apply: true });
    expect(fs.existsSync(session)).toBe(true);
    expect(fs.existsSync(join(home, 'elsewhere'))).toBe(false);
    expect(report.archived.files).toBe(0);
  });

  it('refuses a custom archive destination below home', () => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'));
    const policy = defaultStewardPolicy(home);
    policy.archiveDir = join(home, 'documents/archive');
    const report = runSteward(policy, { home, now, apply: true });
    expect(fs.existsSync(session)).toBe(true);
    expect(fs.existsSync(policy.archiveDir)).toBe(false);
    expect(report.archived.files).toBe(0);
  });

  it.each(['root', 'nested'])('preserves a source when the archive %s is a symlink', (kind) => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'));
    fs.mkdirSync(join(home, '.ashlr'));
    fs.mkdirSync(join(sandbox, 'archive-outside'));
    if (kind === 'nested') fs.mkdirSync(join(home, '.ashlr/archive'));
    fs.symlinkSync(join(sandbox, 'archive-outside'), join(home, '.ashlr/archive', kind === 'nested' ? 'codex-sessions' : ''));
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.existsSync(session)).toBe(true);
    expect(fs.readdirSync(join(sandbox, 'archive-outside'))).toEqual([]);
    expect(report.archived.files).toBe(0);
  });

  it('preserves a source and existing archive destination instead of overwriting it', () => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'));
    const archive = oldFile(join(home, '.ashlr/archive/codex-sessions/keep.jsonl.gz'), 'existing archive');
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.existsSync(session)).toBe(true);
    expect(fs.readFileSync(archive, 'utf8')).toBe('existing archive');
    expect(report.archived.files).toBe(0);
  });

  it('never opens an archive destination link', () => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'));
    const precious = oldFile(join(sandbox, 'outside/precious.txt'), 'unchanged');
    fs.mkdirSync(join(home, '.ashlr/archive/codex-sessions'), { recursive: true });
    fs.symlinkSync(precious, join(home, '.ashlr/archive/codex-sessions/keep.jsonl.gz'));
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.existsSync(session)).toBe(true);
    expect(fs.readFileSync(precious, 'utf8')).toBe('unchanged');
    expect(report.archived.files).toBe(0);
  });

  it('keeps the 24-hour live-file guard even with a shortened custom minAge', () => {
    const log = oldFile(join(home, '.ashlr/logs/recent.log'));
    fs.utimesSync(log, (now - 2 * 3_600_000) / 1000, (now - 2 * 3_600_000) / 1000);
    const policy = defaultStewardPolicy(home);
    policy.minAgeMinutes = 0;
    policy.roots.find((r) => r.id === 'ashlr-logs')!.quotaMB = 0;
    const report = runSteward(policy, { home, now, apply: true });
    expect(fs.existsSync(log)).toBe(true);
    expect(report.deleted.files).toBe(0);
  });

  it('does not follow a nested source directory link while pruning', () => {
    const log = oldFile(join(home, '.ashlr/logs/old.log'));
    const precious = oldFile(join(sandbox, 'outside/empty/keep.txt'));
    fs.symlinkSync(join(sandbox, 'outside'), join(home, '.ashlr/logs/link'));
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(precious)).toBe(true);
    expect(report.deleted.files).toBe(1);
  });

  it('leaves a newly active log intact when it changes after enumeration', async () => {
    const log = oldFile(join(home, '.ashlr/logs/keep.log'));
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike) => {
      const stat = actual.lstatSync(path);
      if (path === log) fs.utimesSync(log, now / 1000, now / 1000);
      return stat;
    }) as typeof fs.lstatSync);
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.existsSync(log)).toBe(true);
    expect(report.deleted.files).toBe(0);
  });

  it('refuses a root swapped to a symlink immediately after enumeration', async () => {
    const original = oldFile(join(home, '.ashlr/logs/keep.log'));
    const outside = oldFile(join(sandbox, 'outside/keep.log'));
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.readdirSync).mockImplementationOnce(((path: fs.PathLike) => {
      const names = actual.readdirSync(path);
      fs.renameSync(join(home, '.ashlr/logs'), join(home, '.ashlr/saved-logs'));
      fs.symlinkSync(join(sandbox, 'outside'), join(home, '.ashlr/logs'));
      return names;
    }) as typeof fs.readdirSync);
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(original.replace('/logs/', '/saved-logs/'))).toBe(true);
    expect(report.deleted.files).toBe(0);
  });

  it('leaves a replacement session intact even when its length and mtime match the scanned file', async () => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'), 'original');
    const saved = join(home, '.codex/sessions/saved.jsonl');
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.readFileSync).mockImplementationOnce(((path: fs.PathOrFileDescriptor) => {
      const data = actual.readFileSync(path);
      fs.renameSync(session, saved);
      oldFile(session, 'replaced');
      return data;
    }) as typeof fs.readFileSync);
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(fs.readFileSync(session, 'utf8')).toBe('replaced');
    expect(fs.readFileSync(saved, 'utf8')).toBe('original');
    expect(report.archived.files).toBe(0);
  });

  it('rechecks source ancestors after verifying an archive and before removing the source', async () => {
    const session = oldFile(join(home, '.codex/sessions/keep.jsonl'), 'original');
    const outside = oldFile(join(sandbox, 'outside/keep.jsonl'), 'outside');
    const actual = await vi.importActual<typeof fs>('node:fs');
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      fs.renameSync(join(home, '.codex/sessions'), join(home, '.codex/saved-sessions'));
      fs.symlinkSync(join(sandbox, 'outside'), join(home, '.codex/sessions'));
    };
    // Exercise the verification boundary with both old pathname reads and
    // descriptor reads: another process replaces the source's parent there.
    vi.mocked(fs.readFileSync).mockImplementation(((path: fs.PathOrFileDescriptor) => {
      const data = actual.readFileSync(path);
      if (typeof path === 'string' && path.endsWith('.gz')) swap();
      return data;
    }) as typeof fs.readFileSync);
    vi.mocked(fs.readSync).mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const count = actual.readSync(...args);
      swap();
      return count;
    }) as typeof fs.readSync);
    const report = runSteward(defaultStewardPolicy(home), { home, now, apply: true });
    expect(actual.readFileSync(outside, 'utf8')).toBe('outside');
    expect(fs.existsSync(session.replace('/sessions/', '/saved-sessions/'))).toBe(true);
    expect(report.archived.files).toBe(0);
  });
});
