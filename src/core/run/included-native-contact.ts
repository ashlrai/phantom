import type { EngineCommand } from '../types.js';
/** Host code creates this only after observing a selected native account's
 * billing boundary. JSON, balance displays and engine labels cannot mint it. */
export interface IncludedNativeContact { readonly includedNativeContact: unique symbol }
const contacts = new WeakMap<object, { engine: 'codex' | 'claude' | 'devin-cli'; command: string; current: () => boolean }>();

export function issueIncludedNativeContact(engine: 'codex' | 'claude' | 'devin-cli', command: EngineCommand, current: () => boolean): IncludedNativeContact {
  const capability = Object.freeze({}) as IncludedNativeContact;
  contacts.set(capability, { engine, command: JSON.stringify(command), current });
  return capability;
}

/** Recheck at every actual spawn, including the existing config recovery. */
export function includedNativeContactCurrent(value: unknown, engine: string | undefined, command: EngineCommand): boolean {
  if (!value || typeof value !== 'object') return false;
  const contact = contacts.get(value);
  try { return contact !== undefined && contact.engine === engine && contact.command === JSON.stringify(command) && contact.current() === true; }
  catch { return false; }
}
