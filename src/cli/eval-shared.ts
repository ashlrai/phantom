/** Shared CLI helpers for `eval` subcommands. */
import type { AshlrConfig } from '../core/types.js';

export function isEvalHelpRequest(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

/** Probe whether a local provider (Ollama / LM Studio) is reachable without cloud fallback. */
export async function isLocalProviderReachable(cfg?: AshlrConfig): Promise<boolean> {
  try {
    const resolved = cfg ?? (await import('../core/config.js')).loadConfig();
    const { getActiveClient } = await import('../core/run/provider-client.js');
    await getActiveClient(resolved, { allowCloud: false });
    return true;
  } catch {
    return false;
  }
}
