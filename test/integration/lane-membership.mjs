// Real source CLI and Locus subprocesses, with private HOME/log/argv fixtures.
// Kept separate from test/config/realio-lane-membership.mjs for queue integration,
// but DERIVED from it — the canonical list is the single source of truth, so an
// integration test joins this view only by entering REAL_IO_TEST_FILES.
import { REAL_IO_TEST_FILES } from '../config/realio-lane-membership.mjs';

export const INTEGRATION_REAL_IO_TEST_FILES = REAL_IO_TEST_FILES.filter((path) =>
  path.startsWith('test/integration/'),
);
