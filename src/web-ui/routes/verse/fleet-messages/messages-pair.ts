/** The two agents the Messages pane is narrowed to: set when a message line is selected on the Map pane, cleared by "Show all". */
import { useSyncExternalStore } from 'react';

export type MessagePair = readonly [string, string];
let pair: MessagePair | null = null;
const listeners = new Set<() => void>();
export function showMessagePair(next: MessagePair | null): void {
  pair = next;
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const current = () => pair;
export const useMessagePair = (): MessagePair | null => useSyncExternalStore(subscribe, current, current);
