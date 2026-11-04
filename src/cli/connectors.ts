import { ConnectorError, importClients, readProfile, updateProfile, validateProfile } from '../core/connectors/profile.js';

const USAGE = `phm connectors list|show <id>|remove <id> [--json]
phm connectors add <id> --kind mcp-stdio|mcp-http|cli|plugin [--command <executable> | --url <https-url>] [--arg <argument>] [--scope <scope>] [--tool <tool>] [--lane <lane>] [--credential <binding=vault-name>] [--json]
phm connectors import [--json]
Metadata only; credentials are Phantom Secrets names. See docs/CONNECTORS.md.`;

export async function cmdConnectors(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (v: unknown): void => { console.log(JSON.stringify(v, null, json ? 2 : undefined)); };
  try {
    const a = args.filter(v => v !== '--json');
    const verb = a.shift();
    if (!verb || ['--help', '-h', 'help'].includes(verb)) { if (json) emit({ usage: USAGE }); else console.log(USAGE); return 0; }
    if (verb === 'list' || verb === 'import') {
      if (a.length) throw new ConnectorError('Unexpected arguments. Run phm connectors --help.');
      if (verb === 'list') { emit(await readProfile()); return 0; }
      const report = await importClients(); emit(report); return report.skipped.length ? 1 : 0;
    }
    if (!['add', 'show', 'remove'].includes(verb)) throw new ConnectorError('Unknown connectors command. Run phm connectors --help.');
    const id = a.shift();
    if (!id || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(id)) throw new ConnectorError('Supply a connector id using letters, digits, dots, underscores or hyphens.');
    if (verb === 'add') {
      const data: Record<string, unknown> = { id, args: [], scopes: [], tools: [], lanes: [], credentials: [] };
      const repeated: Record<string, string> = { '--arg': 'args', '--scope': 'scopes', '--tool': 'tools', '--lane': 'lanes' };
      while (a.length) {
        const flag = a.shift()!;
        const value = a.shift();
        if (!value || value.startsWith('--')) throw new ConnectorError('Option requires a value. Run phm connectors --help.');
        if (repeated[flag]) (data[repeated[flag]!] as string[]).push(value);
        else if (flag === '--credential') {
          const parts = value.split('=');
          if (parts.length !== 2) throw new ConnectorError('Use --credential binding=vault-name; never supply a credential value.');
          (data.credentials as unknown[]).push({ binding: parts[0], name: parts[1] });
        } else if (['--kind', '--command', '--url'].includes(flag) && data[flag.slice(2)] === undefined) data[flag.slice(2)] = value;
        else throw new ConnectorError('Unknown or repeated option. Run phm connectors --help.');
      }
      const connector = validateProfile({ version: 1, connectors: [data] }).connectors[0]!;
      await updateProfile(p => {
        if (p.connectors.some(c => c.id === id)) throw new ConnectorError('Connector already exists. Use show to inspect it or remove before replacing.');
        return { ...p, connectors: [...p.connectors, connector] };
      });
      emit({ ok: true, connector }); return 0;
    }
    if (a.length) throw new ConnectorError('Unexpected arguments. Run phm connectors --help.');
    if (verb === 'show') {
      const connector = (await readProfile()).connectors.find(c => c.id === id);
      if (!connector) throw new ConnectorError('Connector not found. Run phm connectors list or add it first.');
      emit({ connector }); return 0;
    }
    await updateProfile(p => {
      if (!p.connectors.some(c => c.id === id)) throw new ConnectorError('Connector not found. Run phm connectors list.');
      return { ...p, connectors: p.connectors.filter(c => c.id !== id) };
    });
    emit({ ok: true, removed: id }); return 0;
  } catch (e) {
    // Filesystem, TOML and validator exceptions can contain rejected data. Never relay them.
    const error = e instanceof ConnectorError ? e.message : 'Connector operation failed. Check profile permissions and retry; run phm connectors --help.';
    if (json) emit({ ok: false, error }); else console.error(error);
    return 2;
  }
}
