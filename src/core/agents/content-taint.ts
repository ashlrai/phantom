/** Content locality is independent of provider labels and budget policy. */
export function isLoopbackEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const endpoint = new URL(url);
    // URL normalizes abbreviated, integer and hexadecimal IPv4 spellings.
    // Require the literal authority too, rather than trusting that rewrite.
    return /^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url)
      && (endpoint.protocol === 'http:' || endpoint.protocol === 'https:')
      && (endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]');
  } catch { return false; }
}

/** Unknown endpoints fail closed. Never include the endpoint or content in errors. */
export function refuseCloudForImessage(source: string, endpoint: string | undefined): void {
  if (source.trim().toLowerCase() === 'imessage' && !isLoopbackEndpoint(endpoint)) {
    throw new Error('iMessage content requires a loopback model endpoint');
  }
}
