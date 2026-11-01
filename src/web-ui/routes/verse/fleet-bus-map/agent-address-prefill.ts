/** Format a bus address using the printable ASCII token rules of bus-envelope. */
export function agentAddressPrefill(id: string, lastSeenText?: string | null): string | null {
  if (id.length > 128 || !/^[\x21-\x7e]+(?![\s\S])/.test(id)) return null;
  return `@${id}: ${lastSeenText == null ? '' : `\n(last seen ${lastSeenText})`}`;
}
