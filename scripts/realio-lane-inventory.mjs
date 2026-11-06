/** Lane identities use POSIX separators even when discovered on Windows. */
export function canonicalTestPath(value) {
  return value.replaceAll('\\', '/');
}

/** Compare with collected tests, not filesystem existence (directories do not count). */
export function realIoLaneInventory(members, discovered, serialCpuMembers = []) {
  const memberSet = new Set(members.map(canonicalTestPath));
  const cpuSet = new Set(serialCpuMembers.map(canonicalTestPath));
  const discoveredSet = new Set(discovered.map(canonicalTestPath));
  const stale = [...new Set([...memberSet, ...cpuSet])].filter((file) => !discoveredSet.has(file));
  const overlap = [...cpuSet].filter((file) => memberSet.has(file));
  const realIoCount = [...memberSet].filter((file) => discoveredSet.has(file)).length;
  const serialCpuCount = [...cpuSet].filter((file) => discoveredSet.has(file) && !memberSet.has(file)).length;
  return { stale, overlap, realIoCount, serialCpuCount, unitCount: discoveredSet.size - realIoCount - serialCpuCount };
}
