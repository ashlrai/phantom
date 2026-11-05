import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { reconcileCosDelivery } from '../src/core/cos/reconcile.js';
import { readNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'cos-approval-command-'));
  vi.stubEnv('ASHLR_HOME', join(runsDir, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});
const ledger = () => join(runsDir, 'NEEDS-MASON.md');
async function prepare() {
  const id = await queueCosEnvelope({ channel: 'cli', verifiedSenderId: 'test-sender',
    body: 'Prepare a project brief', receivedAt: new Date().toISOString(), dedupeKey: 'a'.repeat(64) }, runsDir);
  const draft = await draftCosResult(id, 'The brief is ready.', runsDir);
  return { id, draft };
}
async function useLegacyLine(id: string) {
  await writeFile(ledger(), `- [ ] Approve chief-of-staff reply ${id}; inspect with phm cos status ${id} --json\n`);
}

describe('chief-of-staff approval command', () => {
  it('writes the registered fleet command in the approval line', async () => {
    const { id } = await prepare();
    expect(await readFile(ledger(), 'utf8')).toContain(
      `Approve chief-of-staff reply ${id}; inspect with phm fleet cos status ${id} --json`);
    expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty('cos');
  });

  it('resolves a legacy line after successful delivery', async () => {
    const { id, draft } = await prepare();
    await useLegacyLine(id);
    await deliverCosResult(id, draft.digest, async () => {}, runsDir);
    expect(readNeedsMason({ runsDir }).items).toEqual([]);
  });

  it('resolves a legacy line when uncertain delivery is reconciled as delivered', async () => {
    const { id, draft } = await prepare();
    await expect(deliverCosResult(id, draft.digest, async () => { throw new Error('failed'); }, runsDir))
      .rejects.toThrow('failed');
    await useLegacyLine(id);
    await reconcileCosDelivery(id, 'delivered', { runsDir });
    expect(readNeedsMason({ runsDir }).items).toEqual([]);
  });
});
