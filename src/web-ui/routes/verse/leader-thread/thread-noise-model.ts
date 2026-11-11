/** Identify legacy CLI misfires and short, conversational status requests. */
export function isFlagOnlyText(text: string): boolean {
  const clean = text.replace(/\r\n/g, '\n').trim();
  return !clean || clean.split(/\s+/).every(token => /^--?[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]+)?$/.test(token));
}

const STATUS_ASKS = new Set([
  'status', 'phantom status', 'fleet status', '/status', "what's the status", 'whats the status',
  'glance', "what's up", "what's running", "what's happening", "how's the fleet", "how's it going",
  'how are we', 'how are things',
]);

export function isStatusAskText(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trimEnd();
  return clean.length <= 40 && (STATUS_ASKS.has(clean) || /^\/status@[a-z0-9_]+$/.test(clean));
}
