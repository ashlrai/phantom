/**
 * Authored synthetic catalog for the memory quality benchmark (protocol phantom-memory-benchmark-v2).
 * CC0-1.0, no private history, no real commands from user sessions. Queries were written before any
 * ranking change and are grouped by how much wording they share with the stored fact.
 */
export interface MemoryBenchmarkFact {
  subject: string; slot: string; text: string;
  /** Shares content words verbatim with the fact. */
  lexical: string;
  /** Shares stems only (plural, -ing, -ment ...), not exact words. */
  inflected: string;
  /** Shares no content word; needs synonyms or semantics. */
  paraphrase: string;
}
export const MEMORY_BENCHMARK_FACTS: readonly MemoryBenchmarkFact[] = Object.freeze([
  { subject: 'build', slot: 'command', text: 'Build the workspace with npm run build:all before packaging.',
    lexical: 'which command runs the build', inflected: 'how are builds produced for packages', paraphrase: 'how do I compile everything' },
  { subject: 'build', slot: 'cache', text: 'Build cache lives under target/cache and is safe to clear.',
    lexical: 'where does the build cache live', inflected: 'clearing cached output', paraphrase: 'can I wipe intermediate artifacts' },
  { subject: 'test', slot: 'command', text: 'Run unit tests with npm run test:ci using one worker.',
    lexical: 'how do I run unit tests', inflected: 'unit testing with workers', paraphrase: 'verify my change locally before pushing' },
  { subject: 'test', slot: 'fixtures', text: 'Test fixtures are synthetic and must never contain customer data.',
    lexical: 'what may test fixtures contain', inflected: 'rules for a fixture and customers', paraphrase: 'can sample inputs include real client records' },
  { subject: 'release', slot: 'branch', text: 'Releases are cut from the stable branch, never from master.',
    lexical: 'which branch are releases cut from', inflected: 'where do we release from', paraphrase: 'where do shipping versions originate' },
  { subject: 'release', slot: 'approver', text: 'Release approvals are owned by the platform lead.',
    lexical: 'who owns release approvals', inflected: 'who approves releasing', paraphrase: 'who signs off before we ship' },
  { subject: 'deploy', slot: 'target', text: 'Deployment target is the staging cluster in us-east.',
    lexical: 'what is the deployment target', inflected: 'where do we deploy', paraphrase: 'which environment receives new rollouts' },
  { subject: 'deploy', slot: 'window', text: 'Deploys are frozen on Fridays after noon Eastern.',
    lexical: 'when are deploys frozen', inflected: 'deploying on a friday', paraphrase: 'is shipping allowed at the end of the week' },
  { subject: 'lint', slot: 'rule', text: 'Lint must pass with zero warnings under clippy.',
    lexical: 'what does lint require', inflected: 'linting warning policy', paraphrase: 'how strict is static analysis' },
  { subject: 'format', slot: 'tool', text: 'Format Rust code with cargo fmt across all crates.',
    lexical: 'how do I format rust code', inflected: 'formatting the crate sources', paraphrase: 'which tool tidies source style' },
  { subject: 'database', slot: 'name', text: 'The primary database is postgres named phantom_main.',
    lexical: 'what is the primary database name', inflected: 'which databases are primary', paraphrase: 'where is persistent data stored' },
  { subject: 'database', slot: 'migrations', text: 'Database migrations run through sqlx and are reviewed before merge.',
    lexical: 'how do database migrations run', inflected: 'migrating schemas with review', paraphrase: 'how do I change table layout safely' },
  { subject: 'api', slot: 'version', text: 'The public API version is v3 and v2 is deprecated.',
    lexical: 'what is the public API version', inflected: 'deprecating old versions', paraphrase: 'which interface revision should clients call' },
  { subject: 'logging', slot: 'policy', text: 'Logs must never include secret values or tokens.',
    lexical: 'what must logs never include', inflected: 'logging policy for a token', paraphrase: 'can credentials appear in diagnostics output' },
  { subject: 'review', slot: 'policy', text: 'Every pull request needs one human review before merge.',
    lexical: 'how many reviews does a pull request need', inflected: 'reviewing and merging requests', paraphrase: 'who must look at code changes first' },
  { subject: 'ci', slot: 'runner', text: 'CI runs on self-hosted macOS and Linux runners.',
    lexical: 'where does CI run', inflected: 'what is the runner setup for CI', paraphrase: 'which machines execute continuous integration' },
  { subject: 'docs', slot: 'site', text: 'Public docs are published at phm.dev and Secrets docs at /secrets.',
    lexical: 'where are public docs published', inflected: 'publishing documentation sites', paraphrase: 'which domain hosts the manual' },
  { subject: 'oncall', slot: 'rotation', text: 'On-call rotation changes every Monday at nine.',
    lexical: 'when does the on-call rotation change', inflected: 'rotating on-call duty weekly', paraphrase: 'who handles pages this week' },
  { subject: 'style', slot: 'naming', text: 'Use kebab-case for file names and camelCase for functions.',
    lexical: 'what case for file names', inflected: 'naming files and a function', paraphrase: 'how should identifiers be spelled' },
  { subject: 'secrets', slot: 'storage', text: 'Secrets are stored in the OS keychain through Phantom, never in env files.',
    lexical: 'where are secrets stored', inflected: 'storing a secret safely', paraphrase: 'where do credentials live on a laptop' },
]);
/** Queries no fact answers. A correct pack is empty. */
export const MEMORY_BENCHMARK_ABSENT_QUERIES: readonly string[] = Object.freeze([
  'where is the office parking', 'who caters friday lunch', 'what color is the logo',
  'which timezone does support use', 'how many vacation days are there', 'what is the guest network name',
]);
