/** Keep leading and internal whitespace intact while bounding the sent text. */
export function trimReply(text: string): string {
  return text.slice(0, 6000).trimEnd();
}

export function canSend(text: string, sending: boolean): boolean {
  return !sending && trimReply(text).trim().length > 0;
}

/** Index of the newest entry, or -1 for an empty list. */
export function scrollTargetIndex(items: ArrayLike<unknown>): number {
  return items.length - 1;
}
