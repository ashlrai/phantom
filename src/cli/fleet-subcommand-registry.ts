/**
 * Literal-specifier loaders for `fleet <name>` convention modules.
 *
 * fleet-subcommand-resolve.ts maps a verb to its module path, but the
 * dispatcher cannot `import(resolved.module)`: the desktop sidecar
 * (scripts/build-sea.mjs — `bun build --compile` of dist/) bundles a dynamic
 * import only when its specifier is a literal, and a variable specifier is
 * resolved at runtime against the binary's virtual FS where it always misses
 * (see test/sidecar-literal-imports-315.test.ts). So each convention verb
 * keeps one literal line here: ship src/cli/fleet-<name>.ts exporting
 * cmdFleet<PascalName>(args: string[]): Promise<number>, then register it.
 * test/daily-ci-fix-nov01.test.ts fails when this map and src/cli/fleet-*.ts
 * drift apart.
 */
export const FLEET_SUBCOMMAND_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  'bet-trace': () => import('./fleet-bet-trace.js'),
  'bus-thread': () => import('./fleet-bus-thread.js'),
  'canary-ladder': () => import('./fleet-canary-ladder.js'),
  'ci-evidence': () => import('./fleet-ci-evidence.js'),
  'ci-failures': () => import('./fleet-ci-failures.js'),
  'ci-nightly': () => import('./fleet-ci-nightly.js'),
  'ci-publish': () => import('./fleet-ci-publish.js'),
  'ci-regression': () => import('./fleet-ci-regression.js'),
  'class-share': () => import('./fleet-class-share.js'),
  'dead-heads': () => import('./fleet-dead-heads.js'),
  'dispatch-summary': () => import('./fleet-dispatch-summary.js'),
  'edit-collisions': () => import('./fleet-edit-collisions.js'),
  'job-read': () => import('./fleet-job-read.js'),
  'lane-truth': () => import('./fleet-lane-truth.js'),
  'launch-proof': () => import('./fleet-launch-proof.js'),
  'meter-drop': () => import('./fleet-meter-drop.js'),
  'runs-read': () => import('./fleet-runs-read.js'),
  'ship-gap': () => import('./fleet-ship-gap.js'),
  'skill-calibration': () => import('./fleet-skill-calibration.js'),
  'stray-slots': () => import('./fleet-stray-slots.js'),
  'wait-jobs': () => import('./fleet-wait-jobs.js'),
  'workers': () => import('./fleet-workers.js'),
};
