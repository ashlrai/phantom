/**
 * Fixed engineering vocabulary for memory ranking: words that name the same thing in everyday team speech
 * ("compile" for build, "ship" for release or deploy, "credentials" for secrets). Pure data, no model, no IO.
 * Groups were written from general software-engineering usage and the benchmark's tuning paraphrases only;
 * the held-out benchmark queries are not a source. A word may belong to several groups.
 */
const GROUPS: readonly (readonly string[])[] = [
  ['build', 'compile', 'compiler', 'compilation'],
  ['cache', 'cached', 'artifact', 'intermediate'],
  ['clear', 'wipe', 'purge', 'delete', 'clean'],
  ['test', 'verify', 'check', 'spec'],
  ['fixture', 'sample', 'mock', 'stub', 'dummy'],
  ['customer', 'client'],
  ['data', 'record'],
  ['release', 'ship', 'version'],
  ['deploy', 'deployment', 'rollout', 'ship', 'production', 'prod'],
  ['approve', 'approval', 'approver', 'sign', 'signoff'],
  ['cluster', 'environment', 'region'],
  ['lint', 'linter', 'clippy', 'analysis'],
  ['format', 'formatter', 'tidy', 'prettier', 'prettify', 'whitespace', 'indentation'],
  ['code', 'source'],
  ['database', 'db', 'datastore', 'persistent', 'sql', 'postgres'],
  ['migration', 'migrate', 'schema', 'table'],
  ['api', 'interface', 'endpoint'],
  ['version', 'revision'],
  ['secret', 'credential', 'password', 'token', 'keychain'],
  ['log', 'logging', 'diagnostic', 'stdout', 'print'],
  ['review', 'reviewer', 'inspect'],
  ['merge', 'land'],
  ['ci', 'pipeline', 'continuous', 'integration'],
  ['runner', 'machine', 'agent', 'host', 'hosted'],
  ['docs', 'documentation', 'manual', 'guide', 'reference'],
  ['site', 'domain', 'url', 'website', 'online'],
  ['oncall', 'pager', 'page', 'paging'],
  ['naming', 'identifier', 'capitalize', 'casing'],
  ['branch', 'ref'],
  ['frozen', 'freeze', 'blocked'],
  ['friday', 'week', 'weekend'],
];
/** Returns the group IDs a stemmed word belongs to. The stem function is the caller's, so both sides fold alike. */
export function memoryVocabulary(stem: (word: string) => string): (word: string) => readonly string[] {
  const index = new Map<string, string[]>();
  GROUPS.forEach((group, id) => group.forEach(word => {
    const key = stem(word); index.set(key, [...new Set([...(index.get(key) ?? []), '~' + id])]);
  }));
  return word => index.get(word) ?? [];
}
