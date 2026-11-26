import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { collectChangedPaths, docsCheckPreflight, healedMergeBase, masterMovedAuthorityDrift, selectChangedFiles, verificationBase } from '../scripts/verify-changed.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

describe('changed verification selection', () => {
  it('selects committed, dirty and untracked candidates once, preserving spaces', () => {
    const changed = ['src/committed.ts', 'scripts/new helper.mjs', 'src/dirty.ts', 'src/dirty.ts', 'README.md', ''];
    expect(selectChangedFiles(changed, changed)).toEqual({
      lintFiles: ['scripts/new helper.mjs', 'src/committed.ts', 'src/dirty.ts'],
      pythonFiles: [],
      shellFiles: [],
      perlFiles: [],
      powershellFiles: [],
      jsonFiles: [],
      jsonlFiles: [],
      xmlFiles: [], rustFiles: [], swiftFiles: [], yamlFiles: [], tomlFiles: [], cssFiles: [], snapFiles: [], patchFiles: [], htmlFiles: [], seatbeltFiles: [], mdcFiles: [], detachedScriptFiles: [],
      webTypecheck: false,
      authorityDrift: true,
      fleetRegistry: false,
      docsCheck: true,
      quarantineCheck: false,
      contribTypecheck: false,
      realioLaneCheck: false,
      verseSyncIoCheck: false,
    });
  });

  it('excludes deleted files from lint while retaining deleted web paths for typecheck', () => {
    expect(selectChangedFiles(['src/gone.ts', 'src/web-ui/old screen.tsx'], [])).toEqual({
      lintFiles: [], pythonFiles: [], shellFiles: [], perlFiles: [], powershellFiles: [], jsonFiles: [], jsonlFiles: [], xmlFiles: [], rustFiles: [], swiftFiles: [], yamlFiles: [], tomlFiles: [], cssFiles: [], snapFiles: [], patchFiles: [], htmlFiles: [], seatbeltFiles: [], mdcFiles: [], detachedScriptFiles: [], webTypecheck: true, authorityDrift: true, fleetRegistry: false, docsCheck: true, quarantineCheck: false, contribTypecheck: false, realioLaneCheck: false, verseSyncIoCheck: false,
    });
  });

  it('selects authority drift for source, test and CODEOWNERS paths including deletions', () => {
    for (const path of ['src/a.ts', 'test/a.ts', '.github/CODEOWNERS']) {
      expect(selectChangedFiles([path], []).authorityDrift).toBe(true);
    }
    expect(selectChangedFiles(['docs/a.md', 'src-other/a.ts'], []).authorityDrift).toBe(false);
  });

  it('selects authority drift for shipped scripts, which the Tier-1 closure also walks', () => {
    expect(selectChangedFiles(['scripts/evaluators/x.mjs'], []).authorityDrift).toBe(true);
    expect(selectChangedFiles(['scripts-other/x.mjs'], []).authorityDrift).toBe(false);
  });

  it('flags a master that moved a drift-relevant path since the merge-base, and ignores docs-only movement', () => {
    const exec = (out: string) => vi.fn().mockReturnValueOnce('abc123\n').mockReturnValueOnce(out);
    expect(masterMovedAuthorityDrift('/r', exec('docs/a.md\0README.md\0') as never)).toBe(false);
    expect(masterMovedAuthorityDrift('/r', exec('docs/a.md\0src/core/x.ts\0') as never)).toBe(true);
    expect(masterMovedAuthorityDrift('/r', exec('') as never)).toBe(false);
  });

  it('checks web changes including assets, but not similarly named directories', () => {
    expect(selectChangedFiles(['src/web-ui/public/icon.svg'], []).webTypecheck).toBe(true);
    expect(selectChangedFiles(['src/web-ui-other/screen.tsx'], []).webTypecheck).toBe(false);
  });

  it('handles no lintable changes and all ESLint source extensions', () => {
    expect(selectChangedFiles(['notes.md'], ['notes.md']).lintFiles).toEqual([]);
    const paths = ['a.js', 'b.cjs', 'c.mjs', 'd.ts', 'e.cts', 'f.mts', 'g.tsx', 'h.jsx'];
    expect(selectChangedFiles(paths, paths).lintFiles).toEqual(paths);
    expect(selectChangedFiles([], [])).toEqual({ lintFiles: [], pythonFiles: [], shellFiles: [], perlFiles: [], powershellFiles: [], jsonFiles: [], jsonlFiles: [], xmlFiles: [], rustFiles: [], swiftFiles: [], yamlFiles: [], tomlFiles: [], cssFiles: [], snapFiles: [], patchFiles: [], htmlFiles: [], seatbeltFiles: [], mdcFiles: [], detachedScriptFiles: [], webTypecheck: false, authorityDrift: false, fleetRegistry: false, docsCheck: false, quarantineCheck: false, contribTypecheck: false, realioLaneCheck: false, verseSyncIoCheck: false });
  });

  it('selects the docs check for markdown changes and deletions, not modified code', () => {
    expect(selectChangedFiles(['docs/guide.md'], ['docs/guide.md']).docsCheck).toBe(true);
    expect(selectChangedFiles(['AGENTS.MD'], ['AGENTS.MD']).docsCheck).toBe(true);
    expect(selectChangedFiles(['src/core/x.ts'], ['src/core/x.ts']).docsCheck).toBe(false);
    expect(selectChangedFiles(['src/gone.ts'], []).docsCheck).toBe(true);
    expect(selectChangedFiles(['docs/gone.md'], []).docsCheck).toBe(true);
  });

  it('selects the quarantine ledger check for test files and the ledger, including deletions', () => {
    for (const path of [
      'test/flaky.test.ts', 'test/nested/dir/suite.test.tsx', 'src/web-ui/x.spec.ts',
      'test/component.test.jsx', 'queue/quarantine.tsv',
    ]) {
      expect(selectChangedFiles([path], [path]).quarantineCheck).toBe(true);
    }
    // A deleted test file can stale a ledger row, so deletions still select.
    expect(selectChangedFiles(['test/gone.test.ts'], []).quarantineCheck).toBe(true);
    expect(selectChangedFiles(['queue/quarantine.tsv'], []).quarantineCheck).toBe(true);
  });

  it('skips the quarantine ledger check for non-test paths and near misses', () => {
    for (const path of [
      'src/core/x.ts', 'docs/guide.md', 'test/helper.ts', 'test/fixtures/data.json',
      'queue/quarantine.tsv.bak', 'test/foo.test.ts.snap', 'latest/test.ts', 'contest/x.ts',
    ]) {
      expect(selectChangedFiles([path], [path]).quarantineCheck).toBe(false);
    }
  });
});

describe('docsCheckPreflight preflight check', () => {
  it('returns ok true when node_modules/marked/package.json exists', () => {
    const result = docsCheckPreflight('/fake/root', (() => true) as unknown as typeof import('node:fs').existsSync);
    expect(result.ok).toBe(true);
  });

  it('returns ok false naming the marked package manifest when absent', () => {
    const result = docsCheckPreflight('/fake/root', (() => false) as unknown as typeof import('node:fs').existsSync);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(result.reason).toContain('node_modules/marked/package.json');
  });
});


describe('Git changed-path discovery', () => {
  it('combines merge-base, index, worktree and untracked NUL-delimited paths', () => {
    const outputs = [
      'base-commit\n',
      'committed.ts\0',
      'staged.ts\0old name.ts\0new name.ts\0reverted.ts\0',
      'dirty.ts\0deleted.ts\0reverted.ts\0',
      'untracked space.ts\0',
    ];
    vi.mocked(execFileSync).mockImplementation(() => outputs.shift()!);
    expect(collectChangedPaths('/fixture')).toEqual([
      'committed.ts', 'staged.ts', 'old name.ts', 'new name.ts', 'reverted.ts',
      'dirty.ts', 'deleted.ts', 'reverted.ts', 'untracked space.ts',
    ]);
    expect(vi.mocked(execFileSync).mock.calls.map((call) => call[1])).toEqual([
      ['merge-base', 'HEAD', 'origin/master'],
      ['diff', '--name-only', '--no-renames', '-z', 'base-commit', 'HEAD', '--'],
      ['diff', '--cached', '--name-only', '--no-renames', '-z', '--'],
      ['diff', '--name-only', '--no-renames', '-z', '--'],
      ['ls-files', '--others', '--exclude-standard', '-z'],
    ]);
  });
});

describe('verificationBase merge-base heal', () => {
  const SHA = 'a'.repeat(40);
  const BOUNDARY = 'b'.repeat(40);

  interface HealScript {
    shallow?: boolean;
    hasMaster?: boolean;
    upstream?: string | null;
    boundary?: string[];
    contains?: Record<string, string>;
    headCount?: number;
    masterCount?: number;
    fetch?: 'ok' | 'fail' | 'timeout';
    mergeBase?: Array<string | Error>;
    head?: string;
  }

  /** Dispatching git mock for the heal probes; records fetch invocations separately. */
  function healExec(script: HealScript) {
    let mergeCalls = 0;
    const fetches: string[][] = [];
    const exec = vi.fn((_file: string, args: string[]) => {
      const cmd = args.join(' ');
      if (cmd === 'merge-base HEAD origin/master') {
        const next = script.mergeBase?.[mergeCalls++] ?? new Error('no merge base');
        if (next instanceof Error) throw next;
        return `${next}\n`;
      }
      if (cmd === 'rev-parse --is-shallow-repository') {
        if (script.shallow === undefined) throw new Error('not a git repository');
        return `${script.shallow}\n`;
      }
      if (cmd === 'rev-parse --verify --quiet origin/master^{commit}') {
        if (!script.hasMaster) throw new Error('unknown revision');
        return `${SHA}\n`;
      }
      if (cmd === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        if (script.upstream == null) throw new Error('no upstream configured');
        return `${script.upstream}\n`;
      }
      if (cmd === 'rev-list --max-parents=0 HEAD') return `${(script.boundary ?? []).join('\n')}\n`;
      if (cmd.startsWith('branch -r --contains ')) {
        const sha = cmd.slice('branch -r --contains '.length).trim();
        const out = script.contains?.[sha];
        if (out === undefined) throw new Error('bad revision');
        return out;
      }
      if (cmd === 'rev-list --count HEAD') return `${script.headCount ?? 0}\n`;
      if (cmd === 'rev-list --count origin/master') return `${script.masterCount ?? 0}\n`;
      if (cmd === 'rev-parse --verify HEAD^{commit}') return `${script.head ?? 'c'.repeat(40)}\n`;
      if (cmd.startsWith('fetch ')) {
        fetches.push([...args]);
        if (script.fetch === 'timeout') {
          const err = new Error('spawnSync git ETIMEDOUT') as Error & { killed?: boolean };
          err.killed = true;
          throw err;
        }
        if (script.fetch === 'fail') throw new Error('could not read from remote repository');
        return '';
      }
      throw new Error(`unexpected git call: ${cmd}`);
    });
    return { exec: exec as never, fetches };
  }

  it('does not fetch when a complete clone has master but truly shares no history', () => {
    const { exec, fetches } = healExec({ shallow: false, hasMaster: true, mergeBase: [new Error('no merge base')] });
    const base = verificationBase('/repo', exec);
    expect(base).toEqual({ base: 'c'.repeat(40), mode: 'status' });
    expect(fetches).toEqual([]);
  });

  it('fetches the master tracking ref for a complete single-branch clone missing origin/master', () => {
    const { exec, fetches } = healExec({ shallow: false, hasMaster: false, fetch: 'ok', mergeBase: [new Error('no merge base'), SHA] });
    const base = verificationBase('/repo', exec);
    expect(base).toEqual({ base: SHA, mode: 'merge-base' });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toEqual(['fetch', '--no-tags', 'origin', '+refs/heads/master:refs/remotes/origin/master']);
  });

  it('deepens master and HEAD-side branches in stages until a shallow clone reaches the fork point', () => {
    const { exec, fetches } = healExec({
      shallow: true,
      hasMaster: false,
      upstream: null,
      boundary: [BOUNDARY],
      contains: { [BOUNDARY]: '  origin/feature\n  origin/HEAD -> origin/master\n  origin/master\n' },
      headCount: 0,
      fetch: 'ok',
      mergeBase: [new Error('no merge base'), new Error('no merge base'), SHA],
    });
    const base = verificationBase('/repo', exec);
    expect(base).toEqual({ base: SHA, mode: 'merge-base' });
    expect(fetches).toHaveLength(2);
    expect(fetches[0]?.[2]).toBe('--deepen=400');
    expect(fetches[1]?.[2]).toBe('--deepen=2000');
    // master always leads; the boundary's containing branch follows; the symref line is skipped.
    expect(fetches[0]?.slice(3)).toEqual([
      'origin',
      '+refs/heads/master:refs/remotes/origin/master',
      '+refs/heads/feature:refs/remotes/origin/feature',
    ]);
  });

  it('uses HEAD upstream for the deepen refspec set when it points at origin', () => {
    const { exec, fetches } = healExec({
      shallow: true,
      hasMaster: true,
      upstream: 'origin/topic-work',
      boundary: [],
      fetch: 'ok',
      mergeBase: [SHA],
    });
    expect(healedMergeBase('/repo', exec)).toBe(SHA);
    expect(fetches[0]?.slice(3)).toEqual([
      'origin',
      '+refs/heads/master:refs/remotes/origin/master',
      '+refs/heads/topic-work:refs/remotes/origin/topic-work',
    ]);
  });

  it('starts the deepen ladder above the deepest known side so it never shortens a ref', () => {
    const { exec, fetches } = healExec({
      shallow: true, hasMaster: true, upstream: null, boundary: [],
      headCount: 10, masterCount: 900, fetch: 'ok',
      mergeBase: [new Error('no merge base'), SHA],
    });
    expect(healedMergeBase('/repo', exec)).toBe(SHA);
    expect(fetches[0]?.[2]).toBe('--deepen=1300');
  });

  it('falls back to status mode after the deepen stages are exhausted', () => {
    const { exec, fetches } = healExec({
      shallow: true, hasMaster: true, upstream: null, boundary: [], headCount: 0,
      fetch: 'ok', mergeBase: [new Error('no merge base'), new Error('no merge base'), new Error('no merge base'), new Error('no merge base')],
    });
    const base = verificationBase('/repo', exec);
    expect(base.mode).toBe('status');
    expect(fetches.map((f) => f[2])).toEqual(['--deepen=400', '--deepen=2000', '--deepen=10000']);
  });

  it('stops after the first timed-out deepen instead of retrying deeper', () => {
    const { exec, fetches } = healExec({ shallow: true, hasMaster: true, fetch: 'timeout' });
    expect(healedMergeBase('/repo', exec)).toBeNull();
    expect(fetches).toHaveLength(1);
  });

  it('returns null for a complete clone when the master fetch times out', () => {
    const { exec, fetches } = healExec({ shallow: false, hasMaster: false, fetch: 'timeout' });
    expect(healedMergeBase('/repo', exec)).toBeNull();
    expect(fetches).toHaveLength(1);
  });
});
