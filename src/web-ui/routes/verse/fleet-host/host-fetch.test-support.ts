export function hostResponse(url: string, runs: unknown, status = 200): Response {
  if (url === '/api/verse/fleet/runs') return Response.json(runs, { status });
  if (url === '/api/verse/apps/control') return Response.json({ ok: true, action: 'list', connected: true, logged: true, apps: [] });
  if (url === '/api/verse/apps/browser') return Response.json({ schema: 'phm.browser/1', version: 1, browser: 'safari', action: 'tabs', ok: true, outcome: 'done', detail: 'Safari is not running. No agent tabs.', running: false, tabs: [], shot: null });
  return new Response(null, { status: 404 });
}
