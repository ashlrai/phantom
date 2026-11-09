// Test-only Node preload (CommonJS, via --require), added to NODE_OPTIONS by test/setup/home.ts. A child
// of a Vitest worker resolves authority (src/core/util/real-home.ts) through
// its HOME, exactly like the in-process default, so CLI fixtures stay
// hermetic. Never shipped or loaded outside the test harness.
if (process.env.VITEST) {
  globalThis[Symbol.for('ashlr.realHome.testOverride')] = { kind: 'homedir' };
}
