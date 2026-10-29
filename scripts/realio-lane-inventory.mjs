/** Lane identities use POSIX separators even when discovered on Windows. */
export function canonicalTestPath(value) {
  return value.replaceAll('\\', '/');
}

/** Compare with collected tests, not filesystem existence (directories do not count). */
export function realIoLaneInventory(members, discovered) {
  const memberSet = new Set(members.map(canonicalTestPath));
  const discoveredSet = new Set(discovered.map(canonicalTestPath));
  const stale = [...memberSet].filter((file) => !discoveredSet.has(file));
  const realIoCount = memberSet.size - stale.length;
  return { stale, realIoCount, unitCount: discoveredSet.size - realIoCount };
}
