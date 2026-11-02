/** Map bus envelope status tokens to POSIX exit codes. */
export function busStatusExitCode(status: string): number {
  switch (status) {
    case 'ok':
    case 'posted':
    case 'duplicate':
      return 0;
    case 'invalid':
      return 2;
    default:
      return 1;
  }
}
