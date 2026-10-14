/** Pure shared runtime markers; importing them must not load grant or resident machinery. */
export const NON_OPERATOR_ENV_MARKERS: readonly string[] = Object.freeze([
  'ASHLR_IN_DAEMON',
  'ASHLR_IN_SWARM',
  'CLAUDECODE',
  'AI_AGENT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
]);
