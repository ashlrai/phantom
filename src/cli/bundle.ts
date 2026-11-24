/** Portable bundle CLI: parsing only; all reads, validation and writes live in core. */
import { exportBundle, importBundle, inspectBundle, readBundleFile, writeBundleFile } from '../core/bundles/index.js';

const USAGE = `phm bundle export agent|tool <id> --out <file> [--include-memory] [--json]
phm bundle inspect <file> [--json]
phm bundle import <file> --as <id> [--apply] [--json]

Import is a dry run unless --apply is present. Connectors and automations
remain disabled, and secret references remain unbound. No keys or network.`;

export async function cmdBundle(args: string[], options: { home?: string } = {}): Promise<number> {
  const json = args.includes('--json');
  const emit = (value: unknown): void => { console.log(JSON.stringify(value, null, json ? undefined : 2)); };
  if (!args.length || args.some(arg => ['--help', '-h', 'help'].includes(arg))) {
    if (json) emit({ usage: USAGE }); else console.log(USAGE);
    return 0;
  }
  try {
    const positional: string[] = [], values: Record<string, string> = {}, flags = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (['--json', '--apply', '--include-memory'].includes(arg)) {
        if (flags.has(arg)) throw new Error();
        flags.add(arg);
      } else if (arg === '--out' || arg === '--as') {
        const value = args[++i];
        if (!value || value.startsWith('-') || values[arg] !== undefined) throw new Error();
        values[arg] = value;
      } else if (arg.startsWith('-')) throw new Error();
      else positional.push(arg);
    }
    const [verb, target, id] = positional;
    if (verb === 'export' && positional.length === 3 && (target === 'agent' || target === 'tool')
      && values['--out'] && !values['--as'] && !flags.has('--apply')
      && (target === 'agent' || !flags.has('--include-memory'))) {
      const bundle = await exportBundle(target, id!, { ...options, includeMemory: flags.has('--include-memory') });
      await writeBundleFile(values['--out'], bundle);
      emit({ ok: true, schema: bundle.schema });
    } else if (verb === 'inspect' && positional.length === 2 && !Object.keys(values).length
      && !flags.has('--apply') && !flags.has('--include-memory')) {
      emit(inspectBundle(await readBundleFile(target!)));
    } else if (verb === 'import' && positional.length === 2 && values['--as'] && !values['--out']
      && !flags.has('--include-memory')) {
      emit(await importBundle(await readBundleFile(target!), { ...options, as: values['--as'], apply: flags.has('--apply') }));
    } else throw new Error();
    return 0;
  } catch {
    // Rejected input and filesystem exceptions may contain values or local paths.
    const error = 'Bundle operation refused. Check metadata, paths and digests; run phm bundle --help.';
    if (json) emit({ ok: false, error }); else console.error(error);
    return 2;
  }
}
