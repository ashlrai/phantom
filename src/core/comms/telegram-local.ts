/** Read-only Telegram commands. Never probe providers or start a daemon. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatOperatorGlance, isOperatorStatusAsk } from '../fleet/operator-glance.js';
import { readOperatorGlance } from '../fleet/operator-glance-read.js';
import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

function snapshot(names: string[]): Record<string, unknown> | null {
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(homedir(), '.ashlr', name), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    } catch { /* try the documented fallback */ }
  }
  return null;
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)) : [];
}
function label(value: unknown): string {
  return typeof value === 'string' ? scrubSecrets(value).replace(/[\r\n]/g, ' ').slice(0, 160) : 'unknown';
}

export async function localTelegramCommand(text: string, cfg: AshlrConfig): Promise<string | null> {
  void cfg;
  if (isOperatorStatusAsk(text)) {
    try {
      return formatOperatorGlance(await readOperatorGlance());
    } catch {
      return 'Fleet status unavailable.';
    }
  }
  const match = /^\s*\/?(queue|usage|approvals)(?:@\w+)?\s*$/i.exec(text);
  if (!match) return null;
  switch (match[1]!.toLowerCase()) {
    case 'queue': {
      const state = snapshot(['queue.v1.json', 'queue.v1', 'router/queue.json', 'ashlr-fleet-queue.json']);
      if (!state) return 'Queue snapshot unavailable. No local queue.v1 or router mirror was found.';
      const items = rows(state['items'] ?? state['queue'] ?? state['tasks']);
      return `Queue (local snapshot): ${items.length} items\n` + items.slice(0, 15).map(r => `${label(r['id'])}: ${label(r['status'] ?? r['state'])} ${label(r['title'])}`).join('\n');
    }
    case 'usage': {
      const state = snapshot(['resource.v1.json', 'resource.v1', 'fleet.json']);
      if (!state) return 'Usage snapshot unavailable. No local resource.v1 or fleet.json was found.';
      const pools = rows(state['pools'] ?? state['resources'] ?? state['accounts']);
      return 'Usage (local snapshot):\n' + (pools.map(r => {
        const used = r['used'], limit = r['limit'];
        const fraction = typeof used === 'number' && typeof limit === 'number' && Number.isFinite(used) && Number.isFinite(limit) && used >= 0 && limit > 0 ? Math.min(1, used / limit) : null;
        const filled = fraction === null ? 0 : Math.round(fraction * 10);
        return `${label(r['name'] ?? r['id'])}: ${fraction === null ? 'unknown' : '[' + '#'.repeat(filled) + '.'.repeat(10 - filled) + '] ' + Math.round(fraction * 100) + '%'}`;
      }).join('\n') || 'No quota readings in this snapshot.');
    }
    default: {
      const { listMemoIds, readLeaderMemo } = await import('../vision/leader-memo.js');
      const actions = listMemoIds().flatMap(id => readLeaderMemo(id)?.actions ?? [])
        .filter(a => a.status === 'escalated' || a.status === 'scheduled' && a.class === 'B');
      return 'Pending approvals:\n' + (actions.slice(0, 15).map(a => `${a.id}: ${scrubSecrets(a.summary)}`).join('\n') || 'None.') + '\nUse the memo Approve button or "approve <actionId>". Existing authority gates still apply.';
    }
  }
}
