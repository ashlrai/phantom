import { readDevinUsage, type DevinUsageResult } from '../fabric/readers/devin-usage.js';
import { assertMetadata } from '../connectors/profile.js';
import type { QuotaEvidence, SeatAdapter } from './seats.js';

const reason = 'no-documented-bot-messaging-api';
const docs = ['https://docs.devin.ai/v3-openapi.json', 'https://docs.devin.ai/work-with-devin/bots', 'https://docs.devin.ai/work-with-devin/bots/usage-limits'];
export async function devinQuota(read: () => Promise<DevinUsageResult> = readDevinUsage): Promise<QuotaEvidence> {
  try {
    const result = await read();
    if ('status' in result) return { status: 'unknown', reason: result.reason, asOf: null };
    if (result.pctUsed === null) return { status: 'unknown', reason: 'unknown-limit', asOf: result.fetchedAt };
    return { status: result.pctUsed >= 100 ? 'exhausted' : 'measured', usedPct: result.pctUsed,
      resetAt: result.resetAt, asOf: result.fetchedAt, source: result.source };
  } catch { return { status: 'unknown', reason: 'reader-unavailable', asOf: null }; }
}
export function createDevinBotAdapter(options: { secretHandle?: string; readUsage?: () => Promise<QuotaEvidence> } = {}): SeatAdapter {
  if (options.secretHandle && !/^phm_[a-z][a-z0-9_]{0,63}$/.test(options.secretHandle)) throw new Error('Invalid secret handle name.');
  let last: QuotaEvidence = { status: 'unknown', reason: 'usage-evidence-missing', asOf: null };
  return {
    kind: 'devin-bot',
    async usage() { last = await (options.readUsage ?? (() => devinQuota()))(); return last; },
    status: async () => ({ status: 'unknown', reason, docs }),
    async message(text) {
      assertMetadata(text);
      const quota = options.readUsage ? await options.readUsage() : last;
      if (quota.status === 'unknown') return { status: 'refused', refused: 'usage-evidence-missing' };
      if (quota.status === 'exhausted' || quota.usedPct >= 100) return { status: 'refused', refused: 'quota-exhausted' };
      return { status: 'advisory', reason, docs };
    },
  };
}
