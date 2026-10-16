import { readCortexBridgeConfig, runCortexBridgeOnce } from '../core/cortex/bridge.js';
import { resourceCheckOptions, resourceCheckPath } from './resource-check-options.js';

const HELP = `usage: ashlr cortex check --config ABS [--json]
       ashlr cortex once --config ABS --execute [--json]

Check the private, explicitly selected bridge configuration offline, or claim one
signed engineering assignment from Cortex and produce a verified pending local
proposal. Once uses configured Codex/Claude subscription resources and writes
private artifacts under the configured root. It never installs a service, merges,
pushes, deploys, or exposes a local listener. The source repository must be clean,
enrolled, explicitly mapped and at the signed commit. No private memory is loaded.
Token environment variables must match CORTEX_*TOKEN; never put tokens in argv.
An uncertain attempt is retained and never automatically executed again.
`;

export async function cmdCortex(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(HELP); return 0; }
  const mode = args[0];
  if (!['check', 'once'].includes(mode ?? '') || args.filter(v => v === '--execute').length !== (mode === 'once' ? 1 : 0)) {
    console.error(HELP); return 2;
  }
  try {
    const parsed = resourceCheckOptions(['check', ...args.slice(1).filter(v => v !== '--execute')], ['--config']);
    const config = readCortexBridgeConfig(resourceCheckPath(parsed.values, '--config'));
    if (mode === 'check') {
      console.log(JSON.stringify({ schemaVersion: 1, state: 'checked', url: config.url, organizationId: config.organizationId,
        repositories: config.repositories.map(v => v.repository), runtimes: config.runtimes, effectsExecuted: false })); return 0;
    }
    const abort = new AbortController(); const stop = () => abort.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try { console.log(JSON.stringify(await runCortexBridgeOnce(config, { signal: abort.signal }))); return 0; }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } catch {
    // Errors may originate in a remote payload or provider CLI: never echo credentials or raw company context.
    console.error('Cortex bridge unavailable. Inspect the private configuration, source commit, live worker credential and retained attempt artifacts.'); return 1;
  }
}
