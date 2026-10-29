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
  ['phm doctor', 'check this machine (provider readiness still needs checking)'],
  ['phm verse', 'open the local workbench; inspect Resources for chat readiness'],
  ['phm run "<goal>"', 'run one small task after checking resource readiness'],
].map(([cmd, what]) => `${cmd!.padEnd(18)}${what}`).concat([
  'Public Connect does not verify local installation, account sign-in or usable quota.',
  'In Resources, finish provider CLI sign-in, API setup or local-model setup; unavailable or unverified capacity is not ready.',
  'Choose Work with me > New chat, select a scratch project or public repo you can edit, and confirm the folder.',
  'Use Automatic for an eligible resource or Advanced to choose an account/model; if none is eligible, finish setup first.',
  'Try: Fix one typo in README.md; show the diff and checks. Leave the change uncommitted.',
  'Review the diff and verification results. Saving a project does not enroll it for unattended work.',
]);

/**
 * The lead `phm setup` prints before its refusal detail, so a new user
 * learns they are not stuck before reading the authority wording.
 */
export function setupRefusalLead(platform: NodeJS.Platform = process.platform): string[] {
  const unattended = platform === 'darwin'
    ? 'For unattended work later, run `phm authority setup` on this Mac.'
    : 'Unattended background work needs macOS (`phm authority setup`); interactive work is available here once its resource prerequisites are met.';
  return [
    'phm setup installs the background service, and that is turned off until standing authority is set up.',
    'You do not need it to get started:',
    ...GETTING_STARTED_LINES.map((line) => `  ${line}`),
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
    'To see the setup steps without running them: phm authority setup --dry-run',
  ];
}
