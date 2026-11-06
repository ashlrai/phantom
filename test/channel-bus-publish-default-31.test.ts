import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import { ashlrHome } from '../src/core/cloud/store.js';

const root = mkdtempSync(join(tmpdir(), 'channel-bus-default-31-'));
const previousHome = process.env.HOME;
const previousAshlr = process.env.ASHLR_HOME;
afterEach(() => {
  process.env.HOME = previousHome;
  process.env.ASHLR_HOME = previousAshlr;
  rmSync(root, { recursive: true, force: true });
});

it('a runsDir-scoped receiver without busRoot never creates a bus store', async () => {
  // Relocate HOME/ASHLR_HOME so the canonical-store assertion cannot observe a
  // store another suite created in this worker's shared test home.
  process.env.HOME = join(root, 'home');
  process.env.ASHLR_HOME = join(root, 'home', '.ashlr');
  const runsDir = join(root, 'runs');
  const receive = createChannelReceiver({ allowedSenderIds: new Set(['fake-mason']), runsDir });
  const result = await receive({ channel: 'cli', verifiedSenderId: 'fake-mason', body: 'hermetic check' });
  expect(result.ok && result.ack.status).toBe('accepted');
  expect(result.ok && result.publishState).toBe('skipped');
  expect(existsSync(join(runsDir, 'bus-inbox'))).toBe(false);
  expect(existsSync(join(ashlrHome(), 'fleet'))).toBe(false);
});
