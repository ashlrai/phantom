/** Shell/JavaScript polyglot header for an executable Node fixture. */
export function nodeFixtureHeader(nodePath = process.execPath): string {
  // The shell command is a JavaScript line comment, so line terminators cannot
  // safely appear in the embedded path even though the shell accepts them.
  if (/[\r\n\u2028\u2029\0]/u.test(nodePath)) throw new Error('Invalid Node fixture path');
  const quoted = `'${nodePath.replace(/'/g, `'"'"'`)}'`;
  return `#!/bin/sh\n// 2>/dev/null; exec ${quoted} "$0" "$@"\n`;
}
