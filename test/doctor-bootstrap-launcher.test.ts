/**
 * `phm doctor` must never execute a companion bootstrap launcher.
 *
 * The npm `locus-cli` launcher runs `cargo install --git ... locus-cli` on any
 * invocation (even `--version`), which outlived doctor and wrote ~/.cargo.
 * `phm companions` classifies such a file as `unsupported-launcher`; doctor's
 * Locus check and the tools registry reuse that classification. Real
 * subprocesses: each fake launcher writes a marker file if it is ever run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocus } from '../src/core/doctor.js';
import {
  locusAgentReport,
  locusAvailable,
  locusAvailableAsync,
  locusExecutableState,
  resetLocusAvailabilityCache,
} from '../src/core/integrations/locus.js';
import { getToolsRegistry } from '../src/core/tools-registry.js';

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
  resetLocusAvailabilityCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('doctor never runs bootstrap launchers', () => {
  it('Locus check reports the launcher as unsupported and never executes it', async () => {
    const dir = fixtureDir();
    const marker = bootstrapLauncher(dir, 'locus');
    vi.stubEnv('PATH', [dir, process.env.PATH ?? ''].join(delimiter));
    vi.stubEnv('LOCUS_ENFORCE', 'off');

    expect(locusExecutableState()).toBe('unsupported-launcher');
    expect(locusAvailable()).toBe(false);
    expect(await locusAvailableAsync()).toBe(false);
    expect(locusAgentReport()).toMatchObject({ available: false });

    const result = checkLocus();
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('unsupported bootstrap launcher');
    expect(result.fix).toContain('cargo install --git https://github.com/ashlrai/locus locus-cli --locked');
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
    const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'docs'))]
      .filter(file => readFileSync(file, 'utf8').includes('--package locus-cli'))
      .map(file => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
