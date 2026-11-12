import { resolve } from 'node:path';
import { leaderAttachmentDir } from '../core/verse/leader-attachment-api.js';
import { listLeaderAttachments } from '../core/verse/leader-attachment-list.js';

export async function cmdFleetAttachments(args: string[]): Promise<number> {
  let json = false;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--limit' && /^\d+$/.test(args[i + 1] ?? '')) limit = Number(args[++i]);
    else { console.error('Usage: ashlr fleet attachments [--json] [--limit N]'); return 2; }
  }
  const result = await listLeaderAttachments({ limit });
  const items = result.items.map(item => ({ ...item, path: resolve(leaderAttachmentDir(), item.name) }));
  if (json) console.log(JSON.stringify({ state: result.state, items }));
  else if (result.state !== 'ok') console.log(`Attachments ${result.state}.`);
  else for (const item of items) {
    const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(item.modifiedAt)) / 60_000);
    console.log(`${item.name}  ${item.type}  ${item.bytes} B  ${minutes} min ago  ${item.path}`);
  }
  return result.state === 'unavailable' ? 1 : 0;
}
