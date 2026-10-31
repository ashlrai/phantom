import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { readSwitches } from './switches-model.js';
export const SWITCHES_PATH = '/api/verse/fleet/control/switches';
function narrow(raw: unknown) {
  const state = readSwitches(raw);
  if (!state) throw new Error('The switch state could not be read.');
  return state;
}
export async function fetchSwitches(signal?: AbortSignal) {
  return narrow(await apiGet<unknown>(SWITCHES_PATH, signal));
}
export async function postSwitch(id: string, on: boolean) {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = narrow(await apiPost<unknown>(SWITCHES_PATH, { id, on }, token));
  touchMutationHold();
  return result;
}
