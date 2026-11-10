import { checkConstitutionRepository } from '../core/constitution-check.js';

const USAGE = 'Usage: phm constitution check [--root <repo>] [--json] [prompt-or-template-path ...]';

export async function cmdConstitution(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  let root = process.cwd();
  const paths: string[] = [];
  let invalid = args[0] !== 'check';
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') continue;
    if (arg === '--root') {
      const value = args[++index];
      if (!value || value.startsWith('-')) { invalid = true; break; }
      root = value;
    } else if (arg.startsWith('-')) invalid = true;
    else paths.push(arg);
  }
  if (invalid) {
    if (json) console.log(JSON.stringify({ ok: false, error: USAGE }));
    else console.error(USAGE);
    return 2;
  }
  try {
    const result = await checkConstitutionRepository(root, paths);
    if (json) console.log(JSON.stringify(result));
    else {
      for (const diagnostic of result.diagnostics) console.log(`${diagnostic.path}:${diagnostic.line}: ${diagnostic.kind} rule ${diagnostic.id}`);
      console.log(`${result.ok ? 'PASS' : 'FAIL'}: ${result.ruleCount} rules, ${result.referenceCount} references in ${result.filesChecked} files`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    return 1;
  }
}
