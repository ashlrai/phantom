import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cosStatus, deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { readNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'cos-sent-needs-'));
  vi.stubEnv('ASHLR_HOME', join(runsDir, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});
async function prepare() {
  const id = await queueCosEnvelope({ channel: 'cli', verifiedSenderId: 'test-sender',
    body: 'Prepare a project brief', receivedAt: new Date().toISOString(), dedupeKey: 'a'.repeat(64) }, runsDir);
  const draft = await draftCosResult(id, 'The brief is ready.', runsDir);
  return { id, draft };
}
const ledger = () => join(runsDir, 'NEEDS-MASON.md');

describe('sent chief-of-staff replies resolve needs-you', () => {
  it('resolves only the matching approval with exactly one marker', async () => {
    const { id, draft } = await prepare();
    const [approval] = readNeedsMason({ runsDir }).items;
    await appendFile(ledger(), '- [ ] Review unrelated project\n');
    await deliverCosResult(id, draft.digest, async () => {}, runsDir);
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
    expect(readNeedsMason({ runsDir }).items.map(item => item.text)).toEqual(['Review unrelated project']);
    const markers = (await readFile(ledger(), 'utf8')).split('\n').filter(line => line.startsWith('- [x] resolved '));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toContain(approval!.id);
    await expect(deliverCosResult(id, draft.digest, async () => {}, runsDir)).rejects.toThrow();
    expect((await readFile(ledger(), 'utf8')).split('\n').filter(line => line.startsWith('- [x] resolved '))).toEqual(markers);
    const bus = JSON.parse(await readFile(join(runsDir, 'home', 'fleet', 'bus-inbox', 'messages.json'), 'utf8'));
    expect(bus.rows).toHaveLength(1);
    expect(bus.rows[0].envelope.body).toMatchObject({ itemId: approval!.id, source: 'desktop' });
    expect(bus.rows[0].envelope.body).not.toHaveProperty('reply');
    expect(JSON.stringify(bus)).not.toContain(draft.text);
  });

  it('keeps the approval open when the send throws and delivery is uncertain', async () => {
    const { id, draft } = await prepare();
    const before = readNeedsMason({ runsDir });
    await expect(deliverCosResult(id, draft.digest, async () => { throw new Error('send failed'); }, runsDir))
      .rejects.toThrow('send failed');
    expect((await cosStatus(id, runsDir)).delivery).toBe('uncertain');
    expect(readNeedsMason({ runsDir })).toEqual(before);
    expect(await readFile(ledger(), 'utf8')).not.toContain('- [x] resolved ');
  });

  it('retains sent delivery when the ledger was deleted', async () => {
    const { id, draft } = await prepare();
    await rm(ledger());
    await expect(deliverCosResult(id, draft.digest, async () => {}, runsDir)).resolves.toBeUndefined();
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
    expect(readNeedsMason({ runsDir }).status).toBe('missing');
  });

  it('retains sent delivery when the bus is unavailable', async () => {
    const { id, draft } = await prepare();
    await writeFile(join(runsDir, 'home'), 'blocked');
    const before = readNeedsMason({ runsDir });
    await expect(deliverCosResult(id, draft.digest, async () => {}, runsDir)).resolves.toBeUndefined();
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
    expect(readNeedsMason({ runsDir })).toEqual(before);
  });
});
