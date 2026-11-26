import { ownerDisplayName } from './owner-display.js';

export async function readOwnerDisplayName(): Promise<string> {
  const { loadConfigReadOnly } = await import('./config.js');
  return ownerDisplayName(loadConfigReadOnly().user?.name);
}
