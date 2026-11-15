/**
 * Vitest child preload. The worker opts into process home with an in-process
 * symbol that a spawned Node process does not inherit. Without this, a test
 * child resolves KILL, enrollment and leases from the passwd home and can
 * write the real ~/.ashlr. Production never loads this file. VITEST is not
 * enough on its own: a process that does not come through this preload keeps
 * the account home. This is CommonJS so `--require` does not switch a child
 * entry point to ESM.
 */
const TEST_SOURCE = Symbol.for('ashlr.real-home.test-source');

if (process.env.VITEST === 'true') {
  globalThis[TEST_SOURCE] = 'process';
}
