import { describe, expect, it } from 'vitest';
import type { Account, AccountCredits, AccountsSnapshot } from '../usage/usage-contract.js';
import { rowsFromAccounts } from './usage-pane-model.js';

function account(over: Partial<Account> & { id: string; provider: Account['provider'] }): Account {
  return {
    label: over.id, state: 'observed', authentication: 'signed-in', health: null, planType: null,
    observedAt: null, windows: [], binding: null, credits: null, reason: null,
    unsupported: null, reconnectCommand: null, notes: [], ...over,
  };
}
const snapshot = (accounts: Account[]): AccountsSnapshot => ({ sampledAt: '2026-10-31T12:00:00Z', refreshing: false, accounts, collectorNote: null });

describe('rowsFromAccounts account facts', () => {
  it('carries observedAt, credits, reconnectCommand and planType straight from the account', () => {
    const credits: AccountCredits = { hasCredits: true, unlimited: false, balance: '42', balanceValue: 42, spendControlReached: false };
    const [row] = rowsFromAccounts(snapshot([account({
      id: 'codex-1', provider: 'codex',
      observedAt: '2026-10-31T11:50:00Z',
      credits,
      reconnectCommand: 'ashlr auth login codex',
      planType: 'pro',
    })]));
    expect(row.observedAt).toBe('2026-10-31T11:50:00Z');
    expect(row.credits).toEqual(credits);
    expect(row.reconnectCommand).toBe('ashlr auth login codex');
    expect(row.planType).toBe('pro');
  });
  it('nulls all four facts when the account does not carry them', () => {
    const [row] = rowsFromAccounts(snapshot([account({ id: 'grok-1', provider: 'grok' })]));
    expect(row).toMatchObject({ observedAt: null, credits: null, reconnectCommand: null, planType: null });
  });
});
