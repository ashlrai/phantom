/** Resolve only safe convention-based CLI module names; never interpolate raw argv. */
export function resolveFleetSubcommand(name: string | undefined): { module: string; exportName: string } | null {
  if (!name || name.length < 2 || name.length > 40 || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) return null;
  return {
    module: `./fleet-${name}.js`,
    exportName: 'cmdFleet' + name.split('-').map(part => part[0]!.toUpperCase() + part.slice(1)).join(''),
  };
}

/** Match the missing target, never a dependency or the importing file in the message. */
export function isModuleNotFound(err: unknown, module: string): boolean {
  if (!(err instanceof Error) || !('code' in err)
    || !['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(String(err.code))) return false;
  const missing = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(err.message)?.[1];
  return missing === module || (module.startsWith('./') && missing?.endsWith('/' + module.slice(2)) === true);
}
