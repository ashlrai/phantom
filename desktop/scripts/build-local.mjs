#!/usr/bin/env node
// Local producer only: build the complete app, sign once, then verify. No install or DMG.
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codesignArgv, ENTITLEMENTS, findSigningIdentity, SIGNING_IDENTITY } from '../../scripts/ship-local.mjs';
import { NATIVE_BUNDLE_ID, NATIVE_EXECUTABLE } from '../../scripts/local-app-transaction.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execute = (bin, args, options) => spawnSync(bin, args, { encoding: 'utf8', ...options });
const fail = message => { throw new Error(`desktop local build: ${message}`); };

/** The runner/root/platform seams are for hermetic tests; CLI paths and commands are fixed. */
export function buildLocal({root = ROOT, platform = process.platform, debug = false, env = process.env, exec = execute} = {}) {
  if (platform !== 'darwin') fail('Ashlr Local signing requires macOS');
  // Keep the native output at the same path consumed by ship:local, regardless of shell defaults.
  const buildEnv = {...env, CARGO_TARGET_DIR: join(root, 'desktop/src-tauri/target')};
  delete buildEnv.CARGO_BUILD_TARGET;
  delete buildEnv.TAURI_CONFIG;
  const run = (bin, args, stdio = 'pipe') => {
    const result = exec(bin, args, {cwd: join(root, 'desktop'), env: buildEnv, stdio});
    if (result.error || result.status !== 0) fail(`${bin} ${args[0]} failed; no verified local app was produced. Check the tool output and Keychain access.`);
    return String(result.stdout ?? '').trim();
  };
  const signer = findSigningIdentity({exec: (_bin, args) => exec('/usr/bin/security', args, {cwd: root, env: buildEnv, encoding: 'utf8'})});
  if (!signer?.valid) fail(`requires an existing valid ${SIGNING_IDENTITY} code-signing identity with its private key. Check security find-identity -p codesigning in the build user's unlocked keychain; restore/trust the configured identity before retrying. No ad-hoc fallback is allowed.`);

  // Tauri must finish copying icons, public assets, sidecar, executable and Info.plist
  // before codesign sees the bundle. --no-sign prevents a second bundle signing pass.
  run('cargo', ['tauri', 'build', ...(debug ? ['--debug'] : []), '--no-sign', '--bundles', 'app',
    '--config', JSON.stringify({bundle: {createUpdaterArtifacts: false}})], 'inherit');
  const app = join(root, `desktop/src-tauri/target/${debug ? 'debug' : 'release'}/bundle/macos/Phantom.app`);
  const requireEntry = (path, directory) => {
    let stat;
    try { stat = lstatSync(path); } catch { fail(`missing final bundle entry ${path}`); }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail(`invalid final bundle entry ${path}`);
  };
  for (const path of [app, join(app, 'Contents/Resources'), join(app, 'Contents/Resources/public')]) requireEntry(path, true);
  for (const path of ['Contents/Info.plist', `Contents/MacOS/${NATIVE_EXECUTABLE}`, 'Contents/MacOS/ashlr']) requireEntry(join(app, path), false);
  for (const [key, value] of [['CFBundleIdentifier', NATIVE_BUNDLE_ID], ['CFBundleExecutable', NATIVE_EXECUTABLE]]) {
    if (run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')]) !== value) fail(`final app has an unsupported ${key}`);
  }
  const signing = codesignArgv(signer.hash, join(root, ENTITLEMENTS), app);
  run('/usr/bin/codesign', signing.slice(1), 'inherit');
  requireEntry(join(app, 'Contents/_CodeSignature/CodeResources'), false);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=identifier "${NATIVE_BUNDLE_ID}" and certificate leaf = H"${signer.hash}"`, app], 'inherit');
  // Nothing writes into the app after signing. ship:local will stage any later install edits.
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--debug')) fail('usage: node scripts/build-local.mjs [--debug]');
    console.log(`Verified local app: ${buildLocal({debug: args[0] === '--debug'})}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
