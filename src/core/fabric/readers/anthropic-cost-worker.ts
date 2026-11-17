// https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve
// Daily buckets; amounts are decimal cents, not dollars. No provider text leaves custody.
export const ANTHROPIC_COST_WORKER = String.raw`
(async () => {
  try {
    const config = JSON.parse(process.argv[1]);
    const key = process.env[config.adminKeyHandle];
    if (!key || /^phm_/.test(key)) return null;
    const now = Date.parse(config.observedAt), start = Date.parse(config.windowStart);
    if (!(start < now) || now > Date.now()) return null;
    const until = Math.floor(now / 86400000) * 86400000 + 86400000;
    let used = 0, page = null, end = start;
    const pages = new Set();
    for (let i = 0; i < 24; i++) {
      const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
      url.searchParams.set('starting_at', config.windowStart);
      url.searchParams.set('ending_at', new Date(until).toISOString());
      url.searchParams.set('bucket_width', '1d');
      url.searchParams.set('limit', '31');
      if (page) url.searchParams.set('page', page);
      const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' } });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > 1048576) return null;
      const body = JSON.parse(text);
      if (!Array.isArray(body.data) || typeof body.has_more !== 'boolean') return null;
      for (const bucket of body.data) {
        const a = Date.parse(bucket.starting_at), b = Date.parse(bucket.ending_at);
        if (a !== end || a > now || !(b > a) || b > until || !Array.isArray(bucket.results)) return null;
        end = b;
        for (const row of bucket.results) {
          if (row.currency !== 'USD' || typeof row.amount !== 'string' || !/^\d+(\.\d+)?$/.test(row.amount)) return null;
          used += Number(row.amount) / 100;
          if (!Number.isFinite(used)) return null;
        }
      }
      if (!body.has_more) return end >= now ? { used, observed_at: new Date(now).toISOString() } : null;
      if (typeof body.next_page !== 'string' || !body.next_page || body.next_page.length > 4096 || pages.has(body.next_page)) return null;
      page = body.next_page; pages.add(page);
    }
    return null;
  } catch { return null; }
})().then(value => process.stdout.write(JSON.stringify(value))).catch(() => process.stdout.write('null'));
`;
