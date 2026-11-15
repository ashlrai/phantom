/** Providers with no official send command. They never spawn a process. */
import type { DeliverResult } from '../channel-policy.js';

export function sendGrokBridge(): DeliverResult {
  return { status: 'refused', reason: 'No official send surface is registered for grok.' };
}

export function sendClaudeBridge(): DeliverResult {
  return { status: 'refused', reason: 'No official send surface is registered for claude.' };
}
