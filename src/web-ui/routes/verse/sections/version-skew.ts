type Version = [number, number, number];

function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as Version;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function versionSkewNote({ desktop, iface, server }: {
  desktop: string | null; iface: string; server: string | null;
}): { text: string; tone: 'warning' | 'info' } | null {
  if (server === null) return null;
  const running = parseVersion(server);
  const ui = parseVersion(iface);
  const shell = desktop === null ? null : parseVersion(desktop);
  if (!running || !ui || (desktop !== null && !shell)) return null;
  if (compare(running, ui) > 0) return { text: `This window shows interface ${iface} but Phantom ${server} is running · reload to use it`, tone: 'warning' };
  if (shell && compare(shell, running) < 0) return { text: `Desktop ${desktop} is older than Phantom ${server} · install the desktop update when offered`, tone: 'warning' };
  if (shell && compare(shell, running) > 0) return { text: `Desktop ${desktop} is ahead of the running Phantom ${server} · the sidecar restarts on the new build when idle`, tone: 'info' };
  return null;
}
