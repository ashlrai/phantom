/**
 * Paraphrase queries for the memory quality benchmark that ranking must not be tuned against (CC0-1.0, synthetic).
 * Separate agents wrote them seeing only the fact texts and keys, under the rule that a query shares no content word or
 * word stem with its fact, plus questions no fact answers. Never edit these to fit the vocabulary.
 */
export interface MemoryBenchmarkHeldOutFact { subject: string; slot: string; queries: readonly [string, string] }
/** Set A: written before the vocabulary, but read while it was being written, so it is not a clean held-out measure. */
export const MEMORY_BENCHMARK_HELD_OUT: readonly MemoryBenchmarkHeldOutFact[] = Object.freeze([
  { subject: 'build', slot: 'command', queries: ['how do i compile everything from scratch', 'what script produces the whole project output'] },
  { subject: 'build', slot: 'cache', queries: ['where are compiled artifacts stashed and can i wipe them', 'okay to delete the leftover compiler output folder'] },
  { subject: 'test', slot: 'command', queries: ['how do i kick off the automated checks locally', 'which script verifies my changes single-threaded'] },
  { subject: 'test', slot: 'fixtures', queries: ['can i copy real client records into sample inputs for specs', 'rules about what goes into mock files for specs'] },
  { subject: 'release', slot: 'branch', queries: ['which line of git history do we ship versions off', 'shipping a new version, what ref should i tag'] },
  { subject: 'release', slot: 'approver', queries: ['who signs off before a version goes out', 'whose green light do i need to ship'] },
  { subject: 'deploy', slot: 'target', queries: ['where does our code end up when we ship it out', 'which environment and region receive new builds'] },
  { subject: 'deploy', slot: 'window', queries: ['is it okay to ship late in the week', 'any days or hours where pushing to prod is blocked'] },
  { subject: 'lint', slot: 'rule', queries: ['how strict is the static analysis gate for rust', 'will a single compiler nag fail the pipeline'] },
  { subject: 'format', slot: 'tool', queries: ['how do i auto-tidy whitespace and indentation', 'what prettifier keeps our source consistent'] },
  { subject: 'database', slot: 'name', queries: ['which db do we connect to by default', 'what\'s our core sql store called'] },
  { subject: 'database', slot: 'migrations', queries: ['how do schema changes get applied', 'who checks table alterations and what library applies them'] },
  { subject: 'api', slot: 'version', queries: ['which endpoint revision should new integrations call', 'is the older interface still supported'] },
  { subject: 'logging', slot: 'policy', queries: ['can i print credentials to stdout while debugging', 'what am i allowed to write into diagnostic output'] },
  { subject: 'review', slot: 'policy', queries: ['can i land my pr without someone looking at it', 'how many sign-offs does a code change require'] },
  { subject: 'ci', slot: 'runner', queries: ['what machines execute our pipeline jobs', 'are build agents ours or github\'s cloud'] },
  { subject: 'docs', slot: 'site', queries: ['where can customers read the product manual online', 'url for the reference guides'] },
  { subject: 'oncall', slot: 'rotation', queries: ['when does pager duty hand off to the next person', 'what day does the pager schedule switch over'] },
  { subject: 'style', slot: 'naming', queries: ['how should i capitalize identifiers and documents in the repo', 'dashes or underscores when titling new source modules'] },
  { subject: 'secrets', slot: 'storage', queries: ['where do credentials live on my laptop', 'is it fine to put passwords in a config text document'] },
]);
export const MEMORY_BENCHMARK_HELD_OUT_ABSENT: readonly string[] = Object.freeze([
  'how much vacation time do new hires get',
  'who signs off on expense reimbursements',
  'what\'s the wifi password for the guest network',
  'which monitoring dashboard shows latency spikes',
  'how do i get a replacement laptop',
  'where is the team offsite next quarter',
]);
/** Set B: written after src/core/memory/vocabulary.ts was frozen (sha256 c60cc212...) and never read before scoring. */
export const MEMORY_BENCHMARK_UNSEEN: readonly MemoryBenchmarkHeldOutFact[] = Object.freeze([
  { subject: 'build', slot: 'command', queries: ['what\'s the right way to compile everything prior to shipping a bundle', 'i\'m new here so how do i produce the full project artifacts ahead of making an installer'] },
  { subject: 'build', slot: 'cache', queries: ['can i wipe the compiled output folder without breaking anything', 'which directory holds leftover compilation intermediates and may i delete them'] },
  { subject: 'test', slot: 'command', queries: ['how should i execute the automated checks locally the way the pipeline does', 'what invocation kicks off the suite in single-threaded mode'] },
  { subject: 'test', slot: 'fixtures', queries: ['may i copy real client records into sample inputs for the suite', 'is it okay to put production user info in mock files'] },
  { subject: 'release', slot: 'branch', queries: ['which line of history do we ship versions off of', 'can a new version tag be made off main'] },
  { subject: 'release', slot: 'approver', queries: ['who signs off before a new version goes out', 'whose permission do i need to ship a version'] },
  { subject: 'deploy', slot: 'target', queries: ['where does our code land when we push it out', 'which environment and region receive new rollouts'] },
  { subject: 'deploy', slot: 'window', queries: ['is there a day of the week when shipping to servers is blocked', 'can i roll out changes on the last weekday once lunchtime has passed'] },
  { subject: 'lint', slot: 'rule', queries: ['how strict is the static analysis gate for rust', 'will the pipeline fail if the analyzer flags any minor issues'] },
  { subject: 'format', slot: 'tool', queries: ['how do i make my source files match the house indentation conventions', 'what auto pretty-printer do we rely on for the backend language'] },
  { subject: 'database', slot: 'name', queries: ['which sql engine holds our core records and what\'s it called', 'what schema do i point my connection string at by default'] },
  { subject: 'database', slot: 'migrations', queries: ['how do schema changes get applied', 'does somebody look over table alterations prior to landing them'] },
  { subject: 'api', slot: 'version', queries: ['which endpoint revision should external integrators call', 'is the older interface still supported'] },
  { subject: 'logging', slot: 'policy', queries: ['is it fine to print credentials to stdout for debugging', 'what am i allowed to write into diagnostic output regarding passwords and keys'] },
  { subject: 'review', slot: 'policy', queries: ['how many people have to sign off on a change prior to landing', 'can i self-approve my own patch and ship it'] },
  { subject: 'ci', slot: 'runner', queries: ['what machines execute our automated pipeline jobs', 'are the build agents ours or a cloud vendor\'s'] },
  { subject: 'docs', slot: 'site', queries: ['where can customers read the product manual online', 'what url has the credential vault guides'] },
  { subject: 'oncall', slot: 'rotation', queries: ['when does pager duty hand off to the next engineer', 'what day and hour does the support shift swap'] },
  { subject: 'style', slot: 'naming', queries: ['how should i title new source documents on disk', 'what capitalization convention applies to methods and modules'] },
  { subject: 'secrets', slot: 'storage', queries: ['where do credentials and passwords get kept on a dev laptop', 'is it okay to paste an access key into a config text document'] },
]);
export const MEMORY_BENCHMARK_UNSEEN_ABSENT: readonly string[] = Object.freeze([
  'how do i book vacation days',
  'what\'s the wifi password at the office',
  'who handles expense reimbursements',
  'which monitoring dashboard shows latency',
  'how do i get a broken laptop replaced',
  'how long is parental leave',
]);
