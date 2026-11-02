/** Recognize browser-specific dynamic import failures without swallowing unrelated rejections. */
export function isChunkLoadError(err: unknown): boolean {
  const message = typeof err === 'string' ? err
    : err && typeof err === 'object' && 'message' in err ? err.message : null;
  return typeof message === 'string' &&
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

export function subscribeChunkErrors(listener: () => void): () => void {
  const onPreloadError = (event: Event): void => {
    event.preventDefault();
    listener();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (isChunkLoadError(event.reason)) listener();
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
