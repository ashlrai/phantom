/**
 * Plain-language guidance for the two setup commands a new user reaches
 * first and cannot finish: `phm setup` (the background service, restricted
 * on every machine until standing authority exists) and `phm authority
 * setup` (Touch ID grants and the custody helper, macOS only).
 *
 * PURE: no IO. The callers print the lines and choose the exit code.
 */

/** What to run instead when the background service is unavailable. */
export const GETTING_STARTED_LINES: readonly string[] = [
  ['phm init', 'set up config and check for local models'],
  ['phm doctor', 'check this machine'],
  ['phm verse', 'open the console'],
  ['phm run "<goal>"', 'run one task now'],
].map(([cmd, what]) => `${cmd!.padEnd(18)}${what}`);

/** Checkable first task guidance; these instructions do not claim live readiness. */
export const FIRST_TASK_READINESS_LINES: readonly string[] = [
  'Connect: add an account or configure a local model in Resources in `phm verse`.',
  '   Check chat readiness: connected alone is not usable. Resolve signed-out, unknown usage, quota or capacity holds before starting.',
  'Select: choose your project and workspace; confirm the repository path before asking for changes.',
  'Check: in Work with me, ask: "Read the README and name one test command with its source path. Do not change files."',
  '   Done: verify the cited file and command in your project. A waiting task or connected badge alone does not pass this check.',
  'For fleet work later, check fleet readiness separately; chat success does not establish fleet authority.',
];

/**
 * The lead `phm setup` prints before its refusal detail, so a new user
 * learns they are not stuck before reading the authority wording.
 */
export function setupRefusalLead(platform: NodeJS.Platform = process.platform): string[] {
  const unattended = platform === 'darwin'
    ? 'For unattended work later, run `phm authority setup` on this Mac.'
    : 'Unattended background work needs macOS (`phm authority setup`); everything above works here.';
  return [
    'phm setup installs the background service, and that is turned off until standing authority is set up.',
    'You do not need it to get started:',
    ...GETTING_STARTED_LINES.map((line) => `  ${line}`),
    ...FIRST_TASK_READINESS_LINES.map((line) => `  ${line}`),
    unattended,
  ];
}

/**
 * `phm authority setup` off macOS: the live run would point at a custody
 * helper and Touch ID that only exist on a Mac and then exit 0. Returns the
 * lines to print (and the caller exits 1), or null to run setup as usual.
 * The read-only plan (`--dry-run`) and help still run everywhere.
 */
export function authoritySetupPlatformRefusal(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  if (platform === 'darwin') return null;
  if (args[0] !== 'setup') return null;
  if (args.some((arg) => arg === '--dry-run' || arg === '--help' || arg === '-h')) return null;
  return [
    `phm authority setup needs macOS: standing grants are signed with Touch ID and held by a macOS custody helper. This machine is ${platform}.`,
    'Nothing was changed. On this machine you can still:',
    ...GETTING_STARTED_LINES.map((line) => `  ${line}`),
    ...FIRST_TASK_READINESS_LINES.map((line) => `  ${line}`),
    'To see the setup steps without running them: phm authority setup --dry-run',
  ];
}
