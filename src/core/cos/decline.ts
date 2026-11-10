/** Bind a decline to the displayed draft and hold the exclusive delivery claim. */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readNeedsMason, resolveNeedsMason } from '../fleet/needs-mason-resolve.js';
import { cosApprovalTexts, cosStatus } from './intake.js';

export async function declineCosDraft(id: string, digest: string, runsDir?: string): Promise<{ id: string; delivery: 'declined' }> {
  if (!/^cos-[a-f0-9]{32}$/.test(id)) throw new Error('Invalid chief-of-staff job id');
  const { draft } = await cosStatus(id, runsDir);
  if (!draft) throw new Error('No chief-of-staff draft');
  if (!/^[a-f0-9]{64}$/.test(digest) || digest !== draft.digest || draft.digest !== createHash('sha256')
    .update(JSON.stringify([draft.id, draft.origin, draft.text])).digest('hex')) {
    throw new Error('Explicit decline of the current draft is required');
  }
  const root = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  await writeFile(join(root, 'cos', `${id}.delivery.json`), JSON.stringify({ state: 'declined' }),
    { flag: 'wx', mode: 0o600 });
  try {
    const item = readNeedsMason({ runsDir: root }).items.find(item => cosApprovalTexts(id).some(text => item.text === text));
    if (item) resolveNeedsMason({ itemId: item.id }, { runsDir: root, source: 'desktop' });
  } catch { /* The durable decline remains authoritative if cleanup fails. */ }
  return { id, delivery: 'declined' };
}
