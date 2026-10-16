import { readCortexBridgeConfig, runCortexBridgeOnce } from '../core/cortex/bridge.js';
import { resourceCheckOptions, resourceCheckPath } from './resource-check-options.js';
import { admitCortexConfiguration, inspectCortexAdmission, revokeCortexConfiguration } from '../core/cortex/admission.js';

const HELP = `usage: phm cortex check --config ABS [--json]
       phm cortex admit --config ABS --execute [--json]
       phm cortex revoke --config ABS --execute [--json]
       phm cortex once --config ABS --execute [--json]

Check the private, explicitly selected bridge configuration offline, or claim one
signed engineering assignment from Cortex and produce a verified pending local
proposal. Once uses the configured Codex subscription resource and writes
private artifacts under the configured root. It never installs a service, merges,
pushes, deploys, or exposes a local listener. The source repository must be clean,
explicitly bridge-admitted, mapped and at the signed commit. Admission never
changes shared-machine enrollment, standing grants or resident jobs. No private memory is loaded.
Current engineering assignments require Codex with native no-network permissions;
project .codex configurations are refused. Token environment variables must match
CORTEX_*TOKEN; never put tokens in argv.
An uncertain attempt is retained and never automatically executed again.
`;

export async function cmdCortex(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(HELP); return 0; }
  const mode = args[0];
  if (!['check', 'admit', 'revoke', 'once'].includes(mode ?? '') || args.filter(v => v === '--execute').length !== (mode === 'check' ? 0 : 1)) {
    console.error(HELP); return 2;
  }
  try {
    const parsed = resourceCheckOptions(['check', ...args.slice(1).filter(v => v !== '--execute')], ['--config']);
    const path = resourceCheckPath(parsed.values, '--config');
    if (mode === 'revoke') { console.log(JSON.stringify(revokeCortexConfiguration(path))); return 0; }
    const config = readCortexBridgeConfig(path);
    if (mode === 'admit') { console.log(JSON.stringify(admitCortexConfiguration(path))); return 0; }
    if (mode === 'check') {
      let admission: 'ready' | 'held' = 'held'; try { inspectCortexAdmission(path); admission = 'ready'; } catch { /* no implicit admit */ }
      console.log(JSON.stringify({ schemaVersion: 1, state: 'checked', admission, url: config.url, organizationId: config.organizationId,
        repositories: config.repositories.map(v => v.repository), runtimes: config.runtimes, effectsExecuted: false })); return 0;
    }
    const abort = new AbortController(); const stop = () => abort.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try { console.log(JSON.stringify(await runCortexBridgeOnce(config, { configPath: path, signal: abort.signal }))); return 0; }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } catch {
    // Errors may originate in a remote payload or provider CLI: never echo credentials or raw company context.
    console.error('Cortex bridge unavailable. Inspect the private configuration, source commit, live worker credential and retained attempt artifacts.'); return 1;
  }
}
