/** Accounts the router must not select again during this process. */

export interface AccountPoolState {
  dead: string[];
}

export function emptyAccountPoolState(): AccountPoolState {
  return { dead: [] };
}

export function markAccountDead(state: AccountPoolState, accountId: string): void {
  if (!state.dead.includes(accountId)) state.dead.push(accountId);
}

export function isAccountDead(state: AccountPoolState, accountId: string): boolean {
  return state.dead.includes(accountId);
}
