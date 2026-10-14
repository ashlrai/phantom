import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';

const USAGE = `usage: ashlr resources launcher check --provider codex|claude|grok
usage: phm resources launcher capabilities --provider codex|claude
  --command ABS_JSON --cwd ABS_PRIVATE_DIR [--timeout-ms 1..30000] [--json]

Runs only help/version arguments through one explicitly selected trusted launcher.
--command is an owned private JSON file containing an absolute executable argv
array, not shell text. --cwd must be an existing private canonical directory.
Wrappers must forward arguments; their behavior is operator-trusted. Native
configuration/cache side effects are not attested by a help-only check.
No login, auth status, model prompt, quota probe, API fallback or update is requested.
Supported means required flags advertised, not working argument combinations,
minimum-version proof when version is unknown, or authenticated model execution.
Grok's upstream ACP evidence is separate: Hub's Grok transport is not implemented.
Capabilities mode reports advertised upstream surfaces separately from Phantom
implementation. It requests no sessions or control; runtime readiness is not
inspected. An observed capability report does not authorize a turn or handoff.
No report, enrollment, ledger or service is installed. Capabilities exit 0 means
help inspection completed (individual capabilities may be unverified); exit 1
means unavailable. Check mode exit codes: 0 required
flags advertised for a Hub transport, 1 incompatible/unavailable,
2 invalid arguments, 130 cancellation.
`;

export async function cmdResourceLauncher(args: string[]): Promise<number> {
  const controller = new AbortController(); const abort = (): void => controller.abort();
  try {
    const capabilities = args[0] === 'capabilities';
    const optionArgs = capabilities ? ['check', ...args.slice(1)] : args;
    const options = resourceCheckOptions(capabilities && args.length === 2 && ['--help', '-h'].includes(args[1]!) ? [args[1]!] : optionArgs, ['--provider', '--command', '--cwd', '--timeout-ms']);
    if (options.help) { console.log(USAGE); return 0; }
    const commandPath = resourceCheckPath(options.values, '--command');
    const cwd = resourceCheckPath(options.values, '--cwd');
    const provider = options.values.get('--provider');
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'grok') throw new ResourceCheckUsageError('Expected codex, claude or grok provider');
    if (capabilities && provider === 'grok') throw new ResourceCheckUsageError('Capabilities supports codex or claude providers');
    const timeoutText = options.values.get('--timeout-ms') ?? '10000'; const timeoutMs = Number(timeoutText);
    if (!/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeoutMs) || timeoutMs > 30_000) {
      throw new ResourceCheckUsageError('Expected timeout from 1 to 30000 milliseconds');
    }
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    const [{ readResourceJson }, { checkResourceLauncherCompatibility }] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/launcher-compatibility.js'),
    ]);
    if (controller.signal.aborted) return 130;
    const command = readResourceJson(commandPath) as string[];
    if (capabilities) {
      const { inspectNativeLauncherCapabilities } = await import('../core/resources/launcher-capabilities.js');
      const report = await inspectNativeLauncherCapabilities({ provider, command, cwd, timeoutMs, signal: controller.signal });
      console.log(options.json ? JSON.stringify(report, null, 2) : [
        `Native capabilities · ${report.provider} · ${report.status} · ${report.reason}`,
        `Version: ${report.version ?? 'unverified'} · Runtime readiness: ${report.runtimeReadiness}`,
        ...report.capabilities.map((capability) => `${capability.id}: ${capability.upstream}; Phantom transport: ${capability.phantomTransport}`),
        report.probeEffects,
        'Sessions inspected: no · Control enabled: no. Existing permissions remain unchanged.',
      ].join('\n'));
      return controller.signal.aborted ? 130 : report.status === 'observed' ? 0 : 1;
    }
    const report = await checkResourceLauncherCompatibility({ provider, command, cwd, timeoutMs, signal: controller.signal });
    console.log(options.json ? JSON.stringify(report, null, 2) : [
      `Native launcher · ${report.provider} · ${report.status} · ${report.reason}`,
      `Version: ${report.version ?? 'unverified'} · Hub transport: ${report.hubTransport}`,
      `Missing flags: ${report.missingFlags.join(', ') || 'none'}`,
      'Help/version evidence only. Authentication, billing route, quota and model execution remain unverified.',
    ].join('\n'));
    return controller.signal.aborted ? 130 : report.status === 'supported' ? 0 : 1;
  } catch (error) {
    const message = error instanceof ResourceCheckUsageError ? error.message : 'Native launcher compatibility check unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return controller.signal.aborted ? 130 : error instanceof ResourceCheckUsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}
