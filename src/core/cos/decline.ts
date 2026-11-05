/** Bind a decline to the displayed draft and hold the exclusive delivery claim. */
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cosStatus } from './intake.js';

export async function declineCosDraft(id: string, digest: string, runsDir?: string): Promise<{ id: string; delivery: 'declined' }> {
  if (!/^cos-[a-f0-9]{32}$/.test(id)) throw new Error('Invalid chief-of-staff job id');
  const { draft } = await cosStatus(id, runsDir);
  if (!draft) throw new Error('No chief-of-staff draft');
  if (!/^[a-f0-9]{64}$/.test(digest) || digest !== draft.digest) {
    throw new Error('Explicit decline of the current draft is required');
  }
  const root = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  await writeFile(join(root, 'cos', `${id}.delivery.json`), JSON.stringify({ state: 'declined' }),
    { flag: 'wx', mode: 0o600 });
  return { id, delivery: 'declined' };
}
