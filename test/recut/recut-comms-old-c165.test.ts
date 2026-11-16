import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ingestIMessages } from '../../src/core/comms/imessage-inbox-bridge.js';
import { writeCursor } from '../../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../../src/core/types.js';

it('keeps a refused patch frame out of the teammate mirror', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'recut-c165-'));
  try {
    const cfg = { comms: { enabled: true, imessageHandle: '+1555010001', imessageAllow: ['+1555010001', '+1555010002'] } } as unknown as AshlrConfig;
    writeCursor(1, runsDir);
    const result = await ingestIMessages(cfg, {
      runsDir, platform: 'darwin',
      poll: async () => ({ ok: true, messages: [{ rowid: 2, handle: '+1555010002', text: 'PATCH-BEGIN malformed', date: 0 }] }),
    });
    expect(result).toMatchObject({ ok: true, cursor: 2, teammate: 0 });
    expect(existsSync(join(runsDir, 'imessage', 'teammates.jsonl'))).toBe(false);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
