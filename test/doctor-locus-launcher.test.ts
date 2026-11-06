/**
 * `phm doctor` must never execute a companion bootstrap launcher. The npm
 * `locus-cli` launcher runs `cargo install --git ... locus-cli` on any
 * invocation (even `--version`). `phm companions` classifies such a file as a
 * bootstrap launcher; doctor's Locus check and the tools registry refuse it.
 *
 * Rebased from #805. The original suite lived in test/locus.probe.test.ts and
 * classified via locusExecutableState() inside integrations/locus.ts — both
 * owner-lane (CODEOWNERS tier-1), so this rebase keeps the seam in
 * companion-inventory (companionExecutableState) and hosts the tests here.
 * The fake launchers below write a marker file if they are ever executed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocus } from '../src/core/doctor.js';
import { companionExecutableState } from '../src/core/companion-inventory.js';
import { getToolsRegistry } from '../src/core/tools-registry.js';

describe('bootstrap launchers are never executed', () => {
  const roots: string[] = [];

  function fixtureDir(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-doctor-launcher-')));
    roots.push(root);
    return root;
  }

  /** A launcher shaped like the npm bootstrap shims: it installs on first run. */
  function bootstrapLauncher(dir: string, name: string): string {
    const marker = join(dir, `${name}.ran`);
    const path = join(dir, name);
    writeFileSync(path, `#!${process.execPath}\n` +
      `// npm launcher: no native binary yet, build it from source.\n` +
      `// cargo install --git https://github.com/ashlrai/locus locus-cli --locked\n` +
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n` +
      `console.log('${name} 9.9.9');\n`);
    chmodSync(path, 0o755);
    return marker;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  describe.skipIf(process.platform === 'win32')('doctor never runs bootstrap launchers', () => {
    it('Locus check reports the launcher as unsupported and never executes it', () => {
      const dir = fixtureDir();
      const marker = bootstrapLauncher(dir, 'locus');
      vi.stubEnv('PATH', [dir, process.env.PATH ?? ''].join(delimiter));
      vi.stubEnv('LOCUS_ENFORCE', 'off');

      expect(companionExecutableState('locus')).toBe('unsupported-launcher');

      const result = checkLocus();
      expect(result.status).toBe('warn');
      expect(result.detail).toContain('unsupported bootstrap launcher');
      expect(result.fix).toContain('cargo install --git https://github.com/ashlrai/locus locus-cli --locked');
      expect(existsSync(marker)).toBe(false);
    });

    it('Locus check fails (not warns) on a launcher when LOCUS_ENFORCE=enforce', () => {
      const dir = fixtureDir();
      const marker = bootstrapLauncher(dir, 'locus');
      vi.stubEnv('PATH', [dir, process.env.PATH ?? ''].join(delimiter));
      vi.stubEnv('LOCUS_ENFORCE', 'enforce');

      const result = checkLocus();
      expect(result.status).toBe('fail');
      expect(result.detail).toContain('unsupported bootstrap launcher');
      expect(existsSync(marker)).toBe(false);
    });

    it('tools registry never executes a bootstrap launcher and does not count it', () => {
      const dir = fixtureDir();
      const markers = ['locus', 'phantom', 'lexicon', 'ashlrcode'].map(name => bootstrapLauncher(dir, name));
      vi.stubEnv('PATH', [dir, process.env.PATH ?? ''].join(delimiter));

      const registry = getToolsRegistry();
      for (const id of ['locus', 'phantom', 'lexicon', 'ashlrcode']) {
        expect(registry.tools.find(tool => tool.id === id)).toMatchObject({ installed: false, path: null, version: null });
      }
      for (const marker of markers) expect(existsSync(marker)).toBe(false);
    });

    it('a non-launcher tool whose version probe fails is not installed, even with a version on stderr', () => {
      const dir = fixtureDir();
      const path = join(dir, 'morphkit');
      writeFileSync(path, `#!${process.execPath}\nconsole.error('morphkit 1.2.3: fatal'); process.exit(1);\n`);
      chmodSync(path, 0o755);
      vi.stubEnv('PATH', [dir, process.env.PATH ?? ''].join(delimiter));

      expect(getToolsRegistry().tools.find(tool => tool.id === 'morphkit'))
        .toMatchObject({ installed: false, version: null, path: null });
    });
  });

  describe('Locus install hint', () => {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    function files(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return files(full);
        return /\.(?:ts|tsx|md)$/u.test(entry.name) ? [full] : [];
      });
    }

    it('uses the positional crate name cargo accepts (no --package flag)', () => {
      // src/core/integrations/locus.ts is owner-lane (CODEOWNERS tier-1); its
      // stale --package hint is excluded here and left for an owner change.
      const OWNER_LANE = new Set(['src/core/integrations/locus.ts']);
      const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'docs'))]
        .map(file => file.slice(ROOT.length + 1))
        .filter(file => !OWNER_LANE.has(file))
        .filter(file => readFileSync(join(ROOT, file), 'utf8').includes('--package locus-cli'));
      expect(offenders).toEqual([]);
    });
  });
});
