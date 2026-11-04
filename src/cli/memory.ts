import { MEMORY_KINDS, MemoryError, addMemory, forgetMemory, listMemory, searchMemory, type MemoryKind } from '../core/cos/memory.js';

const USAGE = `phm memory add "<text>" --kind preference|doctrine|fact [--source <label>] [--json]
phm memory list [--kind preference|doctrine|fact] [--json]
phm memory search <term...> [--json]
phm memory forget <id> [--json]
Entries live in ~/.phantom/memory/. Secret-shaped text is refused; use Phantom Secrets binding names. See docs/MEMORY.md.`;

export async function cmdMemory(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (v: unknown): void => { console.log(JSON.stringify(v, null, json ? 2 : undefined)); };
  const line = (e: { id: string; kind: string; text: string }): string => `${e.id}  [${e.kind}]  ${e.text.replace(/\s*\n\s*/g, ' ')}`;
  try {
    const a = args.filter(v => v !== '--json');
    const verb = a.shift();
    if (!verb || ['--help', '-h', 'help'].includes(verb)) { if (json) emit({ usage: USAGE }); else console.log(USAGE); return 0; }
    const flags: Record<string, string> = {};
    const rest: string[] = [];
    while (a.length) {
      const v = a.shift()!;
      if (v === '--kind' || v === '--source') {
        const value = a.shift();
        if (!value || value.startsWith('--') || flags[v] !== undefined) throw new MemoryError('Option requires one value. Run phm memory --help.');
        flags[v] = value;
      } else if (v.startsWith('--')) throw new MemoryError('Unknown option. Run phm memory --help.');
      else rest.push(v);
    }
    const kindFlag = flags['--kind'];
    if (kindFlag !== undefined && !(MEMORY_KINDS as readonly string[]).includes(kindFlag)) throw new MemoryError(`Unknown kind. Use ${MEMORY_KINDS.join(', ')}.`);
    const kind = kindFlag as MemoryKind | undefined;
    if (verb === 'add') {
      if (rest.length !== 1 || !kind) throw new MemoryError('Use phm memory add "<text>" --kind preference|doctrine|fact.');
      const entry = await addMemory({ kind, text: rest[0]!, source: flags['--source'] });
      if (json) emit({ ok: true, entry }); else console.log(`Remembered ${entry.id}`);
      return 0;
    }
    if (verb === 'list') {
      if (rest.length) throw new MemoryError('Unexpected arguments. Run phm memory --help.');
      const entries = await listMemory({ kind });
      if (json) emit({ ok: true, entries }); else for (const e of entries) console.log(line(e));
      return 0;
    }
    if (verb === 'search') {
      const entries = await searchMemory(rest.join(' '));
      if (json) emit({ ok: true, entries }); else for (const e of entries) console.log(line(e));
      return 0;
    }
    if (verb === 'forget') {
      if (rest.length !== 1) throw new MemoryError('Use phm memory forget <id>.');
      const removed = await forgetMemory(rest[0]!);
      if (!removed) throw new MemoryError('Memory not found. Run phm memory list.');
      if (json) emit({ ok: true, removed: rest[0] }); else console.log(`Forgot ${rest[0]}`);
      return 0;
    }
    throw new MemoryError('Unknown memory command. Run phm memory --help.');
  } catch (e) {
    // Filesystem errors can carry paths or rejected data; relay only our own messages.
    const error = e instanceof MemoryError ? e.message : 'Memory operation failed. Check ~/.phantom/memory permissions and retry.';
    if (json) emit({ ok: false, error }); else console.error(error);
    return 2;
  }
}
