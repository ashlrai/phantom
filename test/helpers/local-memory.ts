import { afterEach, beforeEach, vi } from 'vitest';
import * as memory from '../../src/core/resources/local-memory-fit.js';
// Existing routing fixtures describe a reachable local host. Give that host
// explicit memory evidence; memory refusal cases override this measurement.
beforeEach(() => vi.spyOn(memory, 'localModelFit').mockImplementation((model, tokens = 8192) =>
  memory.memoryFit(model ?? 'fixture', 18 * 1024 ** 3, tokens, { totalBytes: 256 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, swapGrowth: 0 })));
afterEach(() => vi.restoreAllMocks());
