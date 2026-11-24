import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const entry = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export function createHelpFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-top-level-help-')));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const effects = join(root, 'effects.jsonl');
  const guard = join(root, 'guard.mjs');
  mkdirSync(home);
  mkdirSync(cwd);
  writeFileSync(guard, `
import cp from 'node:child_process';
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => {
  appendFileSync(${JSON.stringify(effects)}, 'attempt\\n');
  throw new Error('Help must not launch processes or connect to services');
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = blocked;
net.Socket.prototype.connect = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
`);
  return { root, home, cwd, effects, guard };
}

/** Real source CLI by default; an explicit fixture entry exercises the harness. */
export function runHelp(fixture, args, options = {}) {
  const result = spawnSync(process.execPath, [
    '--import', loader, '--import', pathToFileURL(fixture.guard).href, options.entry ?? entry, ...args,
  ], {
    cwd: fixture.cwd,
    env: {
      HOME: fixture.home, USERPROFILE: fixture.home,
      ASHLR_HOME: join(fixture.home, '.ashlr'),
      ASHLR_RUNS_DIR: join(fixture.home, '.ashlr-runs'),
      XDG_CONFIG_HOME: fixture.home, XDG_DATA_HOME: fixture.home,
      XDG_STATE_HOME: fixture.home, XDG_CACHE_HOME: fixture.home,
      APPDATA: fixture.home, LOCALAPPDATA: fixture.home,
      TMPDIR: fixture.root, TMP: fixture.root, TEMP: fixture.root,
      PATH: '', NO_COLOR: '1', NODE_ENV: 'test',
      ASHLR_LOCUS_FIRM: '0', PHANTOM_NO_UPDATE_CHECK: '1',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    encoding: 'utf8', timeout: options.timeout ?? 30_000,
    maxBuffer: 1024 * 1024, windowsHide: true,
  });
  return { ...result, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

export function helpFixtureSnapshot(fixture) {
  const entries = {};
  function walk(directory, prefix) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      const key = `${prefix}/${item.name}`;
      entries[key] = item.isDirectory() ? null : readFileSync(path).toString('base64');
      if (item.isDirectory()) walk(path, key);
    }
  }
  walk(fixture.home, 'home');
  walk(fixture.cwd, 'work');
  return entries;
}

export function removeHelpFixture(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}
