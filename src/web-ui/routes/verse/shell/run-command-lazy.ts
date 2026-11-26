/**
 * routes/verse/shell/run-command-lazy.ts — the shell's way into run-command.ts
 * without putting it (and the command routing it pulls in) on first paint.
 * Commands asked for before the module arrives run, in order, once it does.
 */
import { useEffect } from 'react';
import { useToast } from '../../../components/primitives/Toast.js';
import type { CommandInvocation } from './command-bus.js';

type RunCommandModule = typeof import('./run-command.js');

let loading: Promise<RunCommandModule> | null = null;
let loaded: RunCommandModule | null = null;

export function loadRunCommand(): Promise<RunCommandModule> {
  loading ??= import('./run-command.js').then((mod) => (loaded = mod));
  return loading;
}

/** executeCatalogCommand, synchronous once run-command has loaded. */
export function runCatalogCommand(id: string, invocation: CommandInvocation = {}): void {
  if (loaded) {
    loaded.executeCatalogCommand(id, invocation);
    return;
  }
  void loadRunCommand().then(
    (mod) => { mod.executeCatalogCommand(id, invocation); },
    (err) => console.error('[verse] command routing failed to load', err),
  );
}

/** useShellCommands, mounted once by the shell; the handlers register when the module arrives. */
export function useLazyShellCommands(): void {
  const { show } = useToast();
  useEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    void loadRunCommand().then((mod) => {
      if (!live) return;
      mod.setShellNotifier((message, tone, durationMs) => show(message, tone, undefined, durationMs));
      const unregister = mod.registerShellCommandHandlers();
      off = () => { mod.setShellNotifier(null); unregister(); };
    }, (err) => console.error('[verse] command routing failed to load', err));
    return () => { live = false; off?.(); };
  }, [show]);
}
