export function hostResponse(url: string, runs: unknown, status = 200): Response {
  if (url === '/api/verse/fleet/runs') return Response.json(runs, { status });
  if (url === '/api/verse/apps/control') return Response.json({ ok: true, action: 'list', connected: true, logged: true, apps: [] });
  return new Response(null, { status: 404 });
}
