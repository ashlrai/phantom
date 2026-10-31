// Real source CLI and Locus subprocesses, with private HOME/log/argv fixtures.
// Kept separate from test/config/realio-lane-membership.mjs for queue integration.
// This file must not import REAL_IO_TEST_FILES: the config list spreads this
// array, so importing it back is a circular TDZ crash at config load.
export const INTEGRATION_REAL_IO_TEST_FILES = [
  'test/integration/locus-credential-boundary.test.ts',
];
