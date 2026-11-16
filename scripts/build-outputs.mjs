/**
 * build-outputs.mjs — the complete inventory of paths the release build writes
 * inside the source tree.
 *
 * Every output lands in a gitignored, untracked location; none is a tracked
 * file. test/build-outputs.test.ts ties this inventory to the real commands
 * (`npm run build` in package.json and the desktop nightly step plan) and to
 * git's ignore rules. scripts/release-isolated-tree.mjs refuses any ignored
 * path after a release build that this inventory does not declare.
 *
 * Paths ending in `/` cover a whole directory. A `*` matches within one path
 * segment. Writes outside the tree (OS temp, RUNNER_TEMP, ~/.npm, ~/.cargo)
 * are not listed: they cannot change the source tree.
 */

/** `npm run build`, in order. Each entry must equal one `&&` segment of package.json scripts.build. */
export const NPM_BUILD_STEPS = Object.freeze([
  Object.freeze({ command: 'npm run check:version', writes: Object.freeze([]) }),
  // tsBuildInfoFile lives under node_modules/.cache (tsconfig.json).
  Object.freeze({ command: 'tsc -p tsconfig.json', writes: Object.freeze(['dist/', 'node_modules/']) }),
  Object.freeze({ command: 'node scripts/authority-surface.mjs', writes: Object.freeze(['dist/']) }),
  Object.freeze({ command: 'node scripts/copy-assets.mjs', writes: Object.freeze(['dist/']) }),
  Object.freeze({ command: 'node scripts/build-preparation-builtin.mjs', writes: Object.freeze(['dist/']) }),
  Object.freeze({ command: 'vite build --config vite.config.web.ts', writes: Object.freeze(['dist/', 'node_modules/']) }),
  Object.freeze({ command: 'node scripts/build-release-dependency-inventory.mjs', writes: Object.freeze(['dist/']) }),
  Object.freeze({ command: 'node scripts/build-identity.mjs', writes: Object.freeze(['dist/']) }),
]);

/** scripts/build-desktop-nightly.mjs buildStepPlan() names → in-tree writes. */
export const DESKTOP_NIGHTLY_STEPS = Object.freeze({
  install: Object.freeze(['node_modules/']),
  // build-sea.mjs runs `npm run build` (NPM_BUILD_STEPS) before compiling.
  'sidecar-build': Object.freeze(['dist/', 'dist-bin/', 'node_modules/']),
  'sidecar-smoke': Object.freeze([]),
  'sidecar-stage': Object.freeze(['desktop/src-tauri/binaries/ashlr-*', 'desktop/src-tauri/resources/']),
  // Release CI passes --existing-icons, which drops this step: regenerating
  // would rewrite tracked rasters. Declared for the full local pipeline.
  icons: Object.freeze(['desktop/src-tauri/icons/*.png', 'desktop/src-tauri/icons/*.icns', 'desktop/src-tauri/icons/*.ico']),
  bundle: Object.freeze(['desktop/src-tauri/target/', 'desktop/src-tauri/gen/']),
  package: Object.freeze(['desktop/dist-nightly/']),
});

/** Outputs the release build may leave in the tree (icons excluded: release CI never regenerates them). */
export const RELEASE_BUILD_OUTPUTS = Object.freeze([...new Set([
  ...NPM_BUILD_STEPS.flatMap((step) => step.writes),
  ...Object.entries(DESKTOP_NIGHTLY_STEPS).filter(([name]) => name !== 'icons').flatMap(([, writes]) => writes),
])].sort());

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function matchesBuildOutput(entry, output) {
  if (output.endsWith('/')) return entry === output || entry.startsWith(output);
  return new RegExp(`^${output.split('*').map(escape).join('[^/]*')}$`).test(entry);
}

/** Ignored files (from `git ls-files --others --ignored`) that no declared output covers. */
export function undeclaredBuildOutputs(entries, outputs = RELEASE_BUILD_OUTPUTS) {
  return entries.filter((entry) => !outputs.some((output) => matchesBuildOutput(entry, output)));
}
